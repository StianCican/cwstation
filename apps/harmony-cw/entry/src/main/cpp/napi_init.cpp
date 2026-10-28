#include "capture_session.h"
#include <napi/native_api.h>
#include <memory>
#include <stdexcept>
using Owner = std::shared_ptr<CaptureSession>;
namespace {
void check(napi_status s) { if (s != napi_ok) throw std::runtime_error("Native interface failure"); }
Owner owner(napi_env env) {
    void* p = nullptr; check(napi_get_instance_data(env, &p));
    if (!p) throw std::runtime_error("Native session unavailable");
    return *static_cast<Owner*>(p);
}
struct Operation {
    Owner session; napi_async_work work = nullptr; napi_deferred deferred = nullptr;
    bool start; uint64_t token = 0; std::string error;
};
napi_value control(napi_env env, bool start) {
    auto op = std::make_unique<Operation>();
    try {
        op->session = owner(env); op->start = start;
        if (start) op->token = op->session->requestStart(); else op->token = op->session->requestStop();
        napi_value promise, name;
        check(napi_create_promise(env, &op->deferred, &promise));
        check(napi_create_string_utf8(env, start ? "cwStart" : "cwStop", NAPI_AUTO_LENGTH, &name));
        check(napi_create_async_work(env, nullptr, name,
            [](napi_env, void* ptr) {
                auto* p = static_cast<Operation*>(ptr);
                try { if (p->start) p->session->start(p->token); else p->session->stop(p->token); }
                catch (const std::exception& e) { p->error = e.what(); }
            },
            [](napi_env env, napi_status status, void* ptr) {
                std::unique_ptr<Operation> p(static_cast<Operation*>(ptr)); napi_value value;
                if (status != napi_ok && p->error.empty()) p->error = "Native operation canceled";
                if (p->error.empty()) {
                    napi_get_undefined(env, &value); napi_resolve_deferred(env, p->deferred, value);
                } else {
                    napi_value message; napi_create_string_utf8(env, p->error.c_str(), NAPI_AUTO_LENGTH, &message);
                    napi_create_error(env, nullptr, message, &value); napi_reject_deferred(env, p->deferred, value);
                }
                napi_delete_async_work(env, p->work);
            }, op.get(), &op->work));
        napi_status r = napi_queue_async_work(env, op->work);
        if (r != napi_ok) {
            napi_delete_async_work(env, op->work);
            napi_value message, error;
            napi_create_string_utf8(env, "无法调度原生操作，请重试", NAPI_AUTO_LENGTH, &message);
            napi_create_error(env, nullptr, message, &error);
            napi_reject_deferred(env, op->deferred, error);
            return promise;
        }
        op.release(); return promise;
    } catch (const std::exception& e) { napi_throw_error(env, nullptr, e.what()); return nullptr; }
}
napi_value start(napi_env env, napi_callback_info) { return control(env, true); }
napi_value stop(napi_env env, napi_callback_info) { return control(env, false); }
napi_value drain(napi_env env, napi_callback_info) {
    try {
        auto s = owner(env)->drain(); napi_value out; check(napi_create_object(env, &out));
        auto string = [&](const char* key, const std::string& v) { napi_value x; check(napi_create_string_utf8(env, v.c_str(), v.size(), &x)); check(napi_set_named_property(env, out, key, x)); };
        auto number = [&](const char* key, double v) { napi_value x; check(napi_create_double(env, v, &x)); check(napi_set_named_property(env, out, key, x)); };
        string("text", s.text); string("error", s.error); string("format", s.format);
        number("level", s.level); number("peak", s.peak); number("droppedSamples", s.droppedSamples); number("truncated", s.truncated);
        napi_value active; check(napi_get_boolean(env, s.running, &active)); check(napi_set_named_property(env, out, "running", active)); return out;
    } catch (const std::exception& e) { napi_throw_error(env, nullptr, e.what()); return nullptr; }
}
napi_value clear(napi_env env, napi_callback_info) {
    try { owner(env)->clear(); napi_value out; check(napi_get_undefined(env, &out)); return out; }
    catch (const std::exception& e) { napi_throw_error(env, nullptr, e.what()); return nullptr; }
}
napi_value init(napi_env env, napi_value exports) {
    auto* ptr = new Owner(std::make_shared<CaptureSession>());
    napi_status registered = napi_set_instance_data(env, ptr, [](napi_env, void* data, void*) {
        auto* retained = static_cast<Owner*>(data);
        (*retained)->requestStop();
        try {
            std::thread([retained]() {
                std::unique_ptr<Owner> holder(retained);
                try { (*holder)->stop(); }
                catch (...) {
                    // Failed native release may still retain callback userdata.
                    if ((*holder)->retainsResources()) holder.release();
                }
            }).detach();
        } catch (...) {
            // No cleanup thread could be created. Retain userdata until process exit.
        }
    }, nullptr);
    if (registered != napi_ok) {
        delete ptr; napi_throw_error(env, nullptr, "无法注册原生会话"); return nullptr;
    }
    napi_property_descriptor properties[] = {
        {"start", nullptr, start, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"stop", nullptr, stop, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"drain", nullptr, drain, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"clear", nullptr, clear, nullptr, nullptr, nullptr, napi_default, nullptr}
    };
    if (napi_define_properties(env, exports, 4, properties) != napi_ok) {
        napi_throw_error(env, nullptr, "无法注册原生操作"); return nullptr;
    }
    return exports;
}
napi_module module = {1, 0, nullptr, init, "cwdecoder", nullptr, {0}};
}
extern "C" __attribute__((constructor)) void RegisterCwDecoder() { napi_module_register(&module); }
