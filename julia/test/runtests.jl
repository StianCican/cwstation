# P0-004 Julia/MWORKS 侧验收测试。
#
# 运行（Windows Syslab/MWORKS 环境）：
#   julia-ty.bat D:\AI\projects\cwstation\julia\test\runtests.jl
# 或从 WSL：
#   cmd.exe /c 'C:\Users\Public\TongYuan\julia-1.10.10\bin\julia-ty.bat D:\AI\projects\cwstation\julia\test\runtests.jl'
#
# 覆盖：E/T 1:3、EE 字符间隔 3、E E 词间隔 7、无尾间隔、边沿、时长/样本量化、
# 固定 seed 逐样本与 WAV hash 复现、不同 seed 变化、全报文 SNR 估计、
# 失败不覆盖/无半成品、非法任务/未来版本/过量输入。

using Test
using JSON3
using WAV
using SHA

include(joinpath(@__DIR__, "..", "CWSignal.jl"))
using .CWSignal

# 测试用最小 Morse 表（生产编码在 TS 侧；这里只为构造测试任务）。
const MORSE = Dict(
    'A' => ".-", 'B' => "-...", 'C' => "-.-.", 'D' => "-..", 'E' => ".", 'F' => "..-.",
    'G' => "--.", 'H' => "....", 'I' => "..", 'J' => ".---", 'K' => "-.-", 'L' => ".-..",
    'M' => "--", 'N' => "-.", 'O' => "---", 'P' => ".--.", 'Q' => "--.-", 'R' => ".-.",
    'S' => "...", 'T' => "-", 'U' => "..-", 'V' => "...-", 'W' => ".--", 'X' => "-..-",
    'Y' => "-.--", 'Z' => "--..",
    '0' => "-----", '1' => ".----", '2' => "..---", '3' => "...--", '4' => "....-",
    '5' => ".....", '6' => "-....", '7' => "--...", '8' => "---..", '9' => "----.",
    '/' => "-..-.", '?' => "..--..", '.' => ".-.-.-", ',' => "--..--",
)

function make_task(text; wpm=20, tone=600.0, sr=8000, snr=10.0, seed=42, ramp=5, extra=Dict{String,Any}())
    normalized = uppercase(strip(replace(text, r"\s+" => " ")))
    words = [[MORSE[c] for c in word] for word in split(normalized, " ") if !isempty(word)]
    task = Dict{String,Any}(
        "contractVersion" => 1,
        "algorithmVersion" => "1.0.0",
        "text" => text,
        "normalizedText" => normalized,
        "morseWords" => words,
        "wpm" => wpm,
        "toneHz" => tone,
        "sampleRateHz" => sr,
        "snrDb" => snr,
        "seed" => seed,
        "rampMs" => ramp,
    )
    merge!(task, extra)
    return task
end

function write_task(path, task)
    open(path, "w") do io
        JSON3.write(io, task)
    end
    return path
end

function run_case(text; parent=mktempdir(), name="out", kwargs...)
    task = make_task(text; kwargs...)
    task_path = write_task(joinpath(parent, name * ".task.json"), task)
    out = joinpath(parent, name)
    result = CWSignal.run_task(task_path, out)
    return (result=result, out=out, task_path=task_path, parent=parent, task=task)
end

function capture_error(f)
    try
        f()
        return nothing
    catch error
        return error
    end
end

function expect_code(f, code)
    error = capture_error(f)
    @test error isa CWSignalError
    @test (error isa CWSignalError ? error.code == code : false)
end

@testset "CWSignal P0-004" begin

    @testset "Codex: normalized text and peak bounds" begin
        mktempdir() do parent
            bad = make_task("E"; extra=Dict{String,Any}("normalizedText" => "T"))
            task_path = write_task(joinpath(parent, "bad.task.json"), bad)
            expect_code(() -> CWSignal.run_task(task_path, joinpath(parent, "bad-out")), "inconsistent_text")
            @test !ispath(joinpath(parent, "bad-out"))
            for snr in (-20.0, 0.0, 60.0)
                run = run_case("E"; parent=parent, name="snr-$(snr)", snr=snr)
                @test max(run.result["peakClean"], run.result["peakNoisy"]) <= 0.95 + eps(Float64)
            end
        end
    end

    @testset "E/T 点划 1:3 与样本时长" begin
        parent = mktempdir()
        e = run_case("E"; parent=parent, name="E")
        t = run_case("T"; parent=parent, name="T")
        seg_e = e.result["keyDownSegments"][1]
        seg_t = t.result["keyDownSegments"][1]
        len_e = seg_e["endSample"] - seg_e["startSample"]
        len_t = seg_t["endSample"] - seg_t["startSample"]
        @test len_e == 480          # wpm=20, sr=8000 → 1 单位 = 480 样本
        @test len_t == 1440
        @test len_t == 3 * len_e
    end

    @testset "EE 字符间隔 3、E E 词间隔 7、无尾间隔" begin
        parent = mktempdir()
        ee = run_case("EE"; parent=parent, name="EE")
        segs = ee.result["keyDownSegments"]
        @test length(segs) == 2
        @test segs[2]["startSample"] - segs[1]["endSample"] == 3 * 480

        ese = run_case("E E"; parent=parent, name="E_E")
        segs2 = ese.result["keyDownSegments"]
        @test length(segs2) == 2
        @test segs2[2]["startSample"] - segs2[1]["endSample"] == 7 * 480

        # 末尾不留额外间隔：最后一段结束就是总样本数。
        @test segs2[end]["endSample"] == ese.result["sampleCount"]
        @test ese.result["sampleCount"] == 4320
    end

    @testset "边沿余弦 ramp 与峰值上限" begin
        parent = mktempdir()
        run = run_case("CQ TEST"; parent=parent, name="ramp")
        samples, fs = WAV.wavread(joinpath(run.out, "clean.wav"))[1:2]
        @test fs == 8000
        @test samples[1] == 0
        @test samples[end] == 0
        @test maximum(abs, samples) <= 0.95 + 1.5 / 32767
    end

    @testset "时长/样本量化误差有界" begin
        parent = mktempdir()
        run = run_case("CQ TEST"; parent=parent, name="quant")
        sr = run.result["params"]["sampleRateHz"]
        @test abs(run.result["durationQuantizationErrorSeconds"]) <= 0.5 / sr + 1e-12
        @test abs(run.result["maxSampleQuantizationErrorSeconds"]) <= 0.5 / sr + 1e-12
        @test run.result["durationSeconds"] ≈ run.result["sampleCount"] / sr
        @test run.result["sampleCount"] == run.result["keyDownSegments"][end]["endSample"]
    end

    @testset "固定 seed 逐样本与 WAV hash 复现" begin
        parent = mktempdir()
        first = run_case("CQ TEST"; parent=parent, name="r1", seed=42)
        second = run_case("CQ TEST"; parent=parent, name="r2", seed=42)
        @test first.result["artifacts"]["cleanWav"]["sha256"] == second.result["artifacts"]["cleanWav"]["sha256"]
        @test first.result["artifacts"]["noisyWav"]["sha256"] == second.result["artifacts"]["noisyWav"]["sha256"]
        noisy1 = WAV.wavread(joinpath(first.out, "noisy.wav"))[1]
        noisy2 = WAV.wavread(joinpath(second.out, "noisy.wav"))[1]
        @test noisy1 == noisy2
    end

    @testset "不同 seed 只改变噪声" begin
        parent = mktempdir()
        a = run_case("CQ TEST"; parent=parent, name="seed42", seed=42)
        b = run_case("CQ TEST"; parent=parent, name="seed43", seed=43)
        @test a.result["artifacts"]["noisyWav"]["sha256"] != b.result["artifacts"]["noisyWav"]["sha256"]
        @test abs(a.result["measuredSnrDb"] - 10.0) < 0.5
        @test abs(b.result["measuredSnrDb"] - 10.0) < 0.5
        # clean/noisy 同比例归一化：增益由 noisy 峰值决定，故不同 seed 的 clean.wav
        # 绝对幅度会不同；去掉增益后的预归一化波形与 seed 无关。
        clean_a = WAV.wavread(joinpath(a.out, "clean.wav"))[1]
        clean_b = WAV.wavread(joinpath(b.out, "clean.wav"))[1]
        base_a = clean_a ./ a.result["normalizationGain"]
        base_b = clean_b ./ b.result["normalizationGain"]
        @test maximum(abs, base_a .- base_b) < 1e-4
    end

    @testset "全报文（含间隔）SNR 估计" begin
        parent = mktempdir()
        run = run_case("CQ TEST"; parent=parent, name="snr10", snr=10.0)
        @test abs(run.result["measuredSnrDb"] - 10.0) < 0.5
        @test run.result["noiseVariance"] !== nothing
        @test run.result["estimatedNoiseVariance"] !== nothing
        @test run.result["estimatedNoiseVariance"] ≈ run.result["noiseVariance"] * run.result["normalizationGain"]^2 rtol = 0.05
    end

    @testset "干净场景 clean/noisy 相同且无 SNR" begin
        parent = mktempdir()
        run = run_case("E E"; parent=parent, name="clean", snr=nothing)
        @test run.result["measuredSnrDb"] === nothing
        @test run.result["noiseVariance"] === nothing
        @test run.result["artifacts"]["cleanWav"]["sha256"] == run.result["artifacts"]["noisyWav"]["sha256"]
    end

    @testset "输出目录不覆盖且失败无半成品" begin
        parent = mktempdir()
        out = joinpath(parent, "existing")
        mkpath(out)
        write(joinpath(out, "keep.txt"), "keep")
        task_path = write_task(joinpath(parent, "overwrite.json"), make_task("E"))
        expect_code(() -> CWSignal.run_task(task_path, out), "output_exists")
        @test read(joinpath(out, "keep.txt"), String) == "keep"
        @test !ispath(joinpath(out, "clean.wav"))

        bad = make_task("E"; extra=Dict{String,Any}("morseWords" => [["x"]]))
        bad_path = write_task(joinpath(parent, "bad.json"), bad)
        bad_out = joinpath(parent, "bad-out")
        expect_code(() -> CWSignal.run_task(bad_path, bad_out), "illegal_morse")
        @test !ispath(bad_out)
        @test isempty(filter(name -> startswith(name, ".cwwave-"), readdir(parent)))
    end

    @testset "非法任务 / 未来版本 / 过量输入被拒绝" begin
        parent = mktempdir()
        cases = [
            ("future", make_task("E"; extra=Dict{String,Any}("contractVersion" => 2)), "unsupported_contract_version"),
            ("algorithm", make_task("E"; extra=Dict{String,Any}("algorithmVersion" => "9.9.9")), "unsupported_algorithm_version"),
            ("bool", make_task("E"; extra=Dict{String,Any}("wpm" => true)), "invalid_field"),
            ("empty", make_task("E"; extra=Dict{String,Any}("morseWords" => [])), "empty_morse"),
            ("emptyword", make_task("E"; extra=Dict{String,Any}("morseWords" => [String[]])), "empty_word"),
            ("illegal", make_task("E"; extra=Dict{String,Any}("morseWords" => [["x"]])), "illegal_morse"),
            ("seed", make_task("E"; extra=Dict{String,Any}("seed" => -1)), "out_of_range"),
            ("snr", make_task("E"; extra=Dict{String,Any}("snrDb" => 99.0)), "out_of_range"),
        ]
        for (name, task, code) in cases
            task_path = write_task(joinpath(parent, name * ".json"), task)
            expect_code(() -> CWSignal.run_task(task_path, joinpath(parent, name * "-out")), code)
        end

        long_text = "E"^401
        long_path = write_task(joinpath(parent, "long.json"), make_task(long_text))
        expect_code(() -> CWSignal.run_task(long_path, joinpath(parent, "long-out")), "oversized_input")

        slow_path = write_task(joinpath(parent, "slow.json"), make_task("E"^400; wpm=5))
        expect_code(() -> CWSignal.run_task(slow_path, joinpath(parent, "slow-out")), "duration_too_long")
    end

    @testset "未知字段保留与元数据" begin
        parent = mktempdir()
        run = run_case("E"; parent=parent, name="extra",
            extra=Dict{String,Any}("customThing" => 123, "another" => "x"))
        @test "customThing" in run.result["unrecognizedTaskFields"]
        @test "another" in run.result["unrecognizedTaskFields"]
        @test run.result["taskSha256"] == bytes2hex(sha256(read(run.task_path)))
        @test run.result["environment"]["juliaVersion"] == string(VERSION)
        @test run.result["environment"]["packages"]["JSON3"] !== nothing
        @test run.result["environment"]["packages"]["WAV"] !== nothing
        @test run.result["executionControl"]["transmits"] == false
        @test run.result["executionControl"]["interactive"] == false
    end
end
