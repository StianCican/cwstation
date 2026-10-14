# CWSignal.jl — Julia/MWORKS 侧 CW 合成与噪声。
#
# 输入：TS `cwwave prepare` 生成的版本化任务 JSON。
# 输出：新建目录中的 clean.wav / noisy.wav / result.json（单声道 16bit PCM）。
#
# 该模块只做离线计算，不参与发射/执行控制，也不做任何交互。
#
# 约定（与 packages/signal 中的 TS 实现逐样本一致）：
#   dot=1，dash=3，元素间隔=1，字符间隔=3，词间隔=7；1 单位 = 1.2/wpm 秒；
#   末尾不留额外间隔；样本边界 = fld(2*u*sr*6 + 5*wpm, 10*wpm)。
# 关键段落来自实际样本边界，绝不由加噪后的过零/能量反推。

module CWSignal

using TyCommunication
using JSON3
using WAV
using SHA

export run_task, CWSignalError

const CONTRACT_VERSION = 1
const ALGORITHM_VERSION = "1.0.0"
const DOT_SECONDS_NUMERATOR = 1.2
const PEAK_CEILING = 0.95

const TEXT_MAX_CHARS = 400
const WPM_MIN, WPM_MAX = 5, 60
const SAMPLE_RATE_MIN, SAMPLE_RATE_MAX = 8000, 48000
const TONE_MIN_HZ, TONE_MAX_HZ = 200, 2000
const SNR_MIN_DB, SNR_MAX_DB = -20.0, 60.0
const SEED_MIN, SEED_MAX = 0, 2^31 - 1
const RAMP_MS_MIN, RAMP_MS_MAX = 0, 50
const DURATION_MAX_SECONDS = 120.0
const MORSE_LETTER_MAX_SYMBOLS = 7
const TASK_FILE_MAX_BYTES = 1_048_576
const KNOWN_TASK_FIELDS = Set([
    :contractVersion, :algorithmVersion, :text, :normalizedText, :morseWords,
    :wpm, :toneHz, :sampleRateHz, :snrDb, :seed, :rampMs,
])

struct CWSignalError <: Exception
    code::String
    message::String
end

Base.showerror(io::IO, e::CWSignalError) = print(io, e.code, ": ", e.message)

_fail(code::AbstractString, message::AbstractString) = throw(CWSignalError(String(code), String(message)))

# ── 校验 ──────────────────────────────────────────────────────────────────

function _require_string(value, name::AbstractString)
    value isa AbstractString || _fail("invalid_field", "$name must be a string")
    String(value)
end

function _require_integer(value, name::AbstractString, lo::Integer, hi::Integer)
    ok = value isa Real && !(value isa Bool) && isfinite(value) && isinteger(value)
    ok || _fail("invalid_field", "$name must be an integer (booleans are not numbers)")
    iv = Int(value)
    (lo <= iv <= hi) || _fail("out_of_range", "$name must be in [$lo, $hi]")
    iv
end

function _require_number(value, name::AbstractString, lo::Real, hi::Real)
    ok = value isa Real && !(value isa Bool) && isfinite(value)
    ok || _fail("invalid_field", "$name must be a finite number")
    fv = Float64(value)
    (lo <= fv <= hi) || _fail("out_of_range", "$name must be in [$lo, $hi]")
    fv
end

function _require_morse_words(value)
    value isa AbstractVector || _fail("invalid_task", "morseWords must be an array of words")
    isempty(value) && _fail("empty_morse", "morseWords must be a non-empty array")
    words = Vector{Vector{String}}()
    total_letters = 0
    for word in value
        word isa AbstractVector || _fail("invalid_task", "each Morse word must be an array of letters")
        isempty(word) && _fail("empty_word", "each Morse word must be a non-empty array")
        letters = String[]
        for letter in word
            letter isa AbstractString || _fail("illegal_morse", "each Morse letter must be a string")
            text = String(letter)
            occursin(r"^[.\-]+$", text) || _fail("illegal_morse", "illegal Morse letter: $(repr(text))")
            length(text) <= MORSE_LETTER_MAX_SYMBOLS ||
                _fail("illegal_morse", "Morse letter exceeds $MORSE_LETTER_MAX_SYMBOLS symbols")
            push!(letters, text)
            total_letters += 1
        end
        push!(words, letters)
    end
    total_letters == 0 && _fail("empty_morse", "morseWords contains no letters")
    total_letters <= TEXT_MAX_CHARS || _fail("oversized_input", "too many Morse letters")
    words
end

# ── 时间轴 ────────────────────────────────────────────────────────────────

sample_at(unit::Integer, sample_rate::Integer, wpm::Integer) = fld(2 * unit * sample_rate * 6 + 5 * wpm, 10 * wpm)

function _build_timeline(words, sample_rate::Int, wpm::Int)
    segments = Tuple{Int,Int}[]
    boundaries = Set{Int}([0])
    unit = 0
    for (wi, word) in enumerate(words)
        wi > 1 && (unit += 7)
        for (ci, letter) in enumerate(word)
            ci > 1 && (unit += 3)
            for (si, symbol) in enumerate(letter)
                si > 1 && (unit += 1)
                symbol_units = symbol == '.' ? 1 : 3
                start_sample = sample_at(unit, sample_rate, wpm)
                push!(boundaries, unit)
                unit += symbol_units
                end_sample = sample_at(unit, sample_rate, wpm)
                push!(boundaries, unit)
                push!(segments, (start_sample, end_sample))
            end
        end
    end
    total_units = unit
    exact_duration = total_units * DOT_SECONDS_NUMERATOR / wpm
    sample_count = sample_at(total_units, sample_rate, wpm)
    duration = sample_count / sample_rate
    seconds_per_unit = DOT_SECONDS_NUMERATOR / wpm
    max_error = 0.0
    for boundary in boundaries
        error = abs(sample_at(boundary, sample_rate, wpm) / sample_rate - boundary * seconds_per_unit)
        max_error = max(max_error, error)
    end
    return (
        total_units=total_units,
        sample_count=sample_count,
        exact_duration=exact_duration,
        duration=duration,
        duration_error=duration - exact_duration,
        max_error=max_error,
        segments=segments,
    )
end

# ── 任务校验 ──────────────────────────────────────────────────────────────

function _validate_task(obj)
    haskey(obj, :contractVersion) || _fail("invalid_task", "missing contractVersion")
    contract_version = _require_integer(obj.contractVersion, "contractVersion", 0, typemax(Int64))
    contract_version == CONTRACT_VERSION ||
        _fail("unsupported_contract_version", "unsupported contractVersion $contract_version")

    haskey(obj, :algorithmVersion) || _fail("invalid_task", "missing algorithmVersion")
    algorithm_version = _require_string(obj.algorithmVersion, "algorithmVersion")
    algorithm_version == ALGORITHM_VERSION ||
        _fail("unsupported_algorithm_version", "unsupported algorithmVersion $(repr(algorithm_version))")

    text = _require_string(get(obj, :text, nothing), "text")
    length(text) <= TEXT_MAX_CHARS || _fail("oversized_input", "text exceeds $TEXT_MAX_CHARS characters")
    normalized_text = _require_string(get(obj, :normalizedText, nothing), "normalizedText")
    isempty(normalized_text) && _fail("empty_message", "normalizedText must not be empty")
    length(normalized_text) <= TEXT_MAX_CHARS ||
        _fail("oversized_input", "normalizedText exceeds $TEXT_MAX_CHARS characters")
    normalized_text == uppercase(strip(replace(text, r"\s+" => " "))) ||
        _fail("inconsistent_text", "normalizedText does not match text")

    wpm = _require_integer(get(obj, :wpm, nothing), "wpm", WPM_MIN, WPM_MAX)
    sample_rate = _require_integer(get(obj, :sampleRateHz, nothing), "sampleRateHz", SAMPLE_RATE_MIN, SAMPLE_RATE_MAX)
    tone = _require_number(get(obj, :toneHz, nothing), "toneHz", TONE_MIN_HZ, TONE_MAX_HZ)
    tone < sample_rate / 2 || _fail("out_of_range", "toneHz must be below the Nyquist frequency")
    seed = _require_integer(get(obj, :seed, nothing), "seed", SEED_MIN, SEED_MAX)
    ramp_ms = _require_integer(get(obj, :rampMs, nothing), "rampMs", RAMP_MS_MIN, RAMP_MS_MAX)

    haskey(obj, :snrDb) || _fail("invalid_field", "snrDb is required (use null for a clean scenario)")
    snr = obj.snrDb === nothing ? nothing : _require_number(obj.snrDb, "snrDb", SNR_MIN_DB, SNR_MAX_DB)

    haskey(obj, :morseWords) || _fail("invalid_task", "missing morseWords")
    words = _require_morse_words(obj.morseWords)

    timeline = _build_timeline(words, sample_rate, wpm)
    timeline.exact_duration <= DURATION_MAX_SECONDS ||
        _fail("duration_too_long", "exact duration $(timeline.exact_duration)s exceeds $(DURATION_MAX_SECONDS)s")
    timeline.sample_count <= DURATION_MAX_SECONDS * sample_rate ||
        _fail("duration_too_long", "sample count exceeds the 120s budget")

    extra = sort([String(k) for k in keys(obj) if !(k in KNOWN_TASK_FIELDS)])

    return (
        contract_version=contract_version,
        algorithm_version=algorithm_version,
        text=text,
        normalized_text=normalized_text,
        words=words,
        wpm=wpm,
        sample_rate=sample_rate,
        tone=tone,
        snr=snr,
        seed=seed,
        ramp_ms=ramp_ms,
        timeline=timeline,
        unrecognized_fields=extra,
    )
end

# ── 合成与噪声 ────────────────────────────────────────────────────────────

function _synthesize(task)
    sample_rate = task.sample_rate
    n = task.timeline.sample_count
    time = (0:(n - 1)) ./ sample_rate
    carrier = sin.(2 * pi * task.tone .* time)
    envelope = zeros(Float64, n)
    ramp_samples = round(Int, task.ramp_ms * sample_rate / 1000)
    for (start_sample, end_sample) in task.timeline.segments
        length_samples = end_sample - start_sample
        ramp = min(ramp_samples, div(length_samples, 2))
        for i in 0:(length_samples - 1)
            gain = 1.0
            if ramp > 0
                if i < ramp
                    gain = 0.5 * (1 - cos(pi * i / ramp))
                elseif i >= length_samples - ramp
                    gain = 0.5 * (1 - cos(pi * (length_samples - 1 - i) / ramp))
                end
            end
            envelope[start_sample + i + 1] = gain
        end
    end
    return carrier .* envelope
end

function _add_noise(clean, task)
    if task.snr === nothing
        return copy(clean), nothing
    end
    noisy, variance = TyCommunication.awgn(clean, task.snr, "measured", task.seed; nargout=2)
    return noisy, Float64(variance)
end

_pkg_version(mod::Module) = (version = pkgversion(mod); version === nothing ? nothing : string(version))

function _write_result(path::AbstractString, result::Dict{String,Any})
    open(path, "w") do io
        JSON3.write(io, result)
    end
end

# ── 入口 ──────────────────────────────────────────────────────────────────

"""
    run_task(task_path, output_dir)

读取任务 JSON，校验后合成 clean/noisy WAV 与 result.json，原子发布到
新建的 output_dir（必须不存在；父目录必须存在）。返回结果字典。
失败时只清理本次新建的临时目录，绝不删除用户已有目录。
"""
function run_task(task_path::AbstractString, output_dir::AbstractString)
    isfile(task_path) || _fail("task_not_found", "task file not found: $task_path")
    filesize(task_path) <= TASK_FILE_MAX_BYTES ||
        _fail("task_too_large", "task file exceeds $TASK_FILE_MAX_BYTES bytes")
    raw = read(task_path)
    length(raw) <= TASK_FILE_MAX_BYTES || _fail("task_too_large", "task file exceeds $TASK_FILE_MAX_BYTES bytes")

    obj = try
        JSON3.read(raw)
    catch error
        _fail("invalid_json", "task is not valid JSON: $(sprint(showerror, error))")
    end
    obj isa JSON3.Object || _fail("invalid_task", "task must be a JSON object")

    task = _validate_task(obj)
    task_sha256 = bytes2hex(sha256(raw))

    output = abspath(output_dir)
    parent = dirname(output)
    isdir(parent) || _fail("output_parent_missing", "output parent directory does not exist: $parent")
    ispath(output) && _fail("output_exists", "output directory already exists: $output")

    temp_dir = mktempdir(parent; prefix=".cwwave-")
    published = false
    try
        clean = _synthesize(task)
        noisy, awgn_variance = _add_noise(clean, task)

        # clean/noisy 使用同一比例增益，归一化到峰值 <= 0.95，避免截幅破坏 SNR。
        peak_reference = max(maximum(abs, clean), maximum(abs, noisy))
        gain = peak_reference > 0 ? PEAK_CEILING / peak_reference : 1.0
        clean .*= gain
        noisy .*= gain
        peak_clean = maximum(abs, clean)
        peak_noisy = maximum(abs, noisy)

        if task.snr === nothing
            measured_snr = nothing
            estimated_variance = nothing
        else
            noise = noisy .- clean
            signal_power = sum(abs2, clean)
            noise_power = sum(abs2, noise)
            measured_snr = 10 * log10(signal_power / noise_power)
            estimated_variance = noise_power / length(noise)
        end

        clean_path = joinpath(temp_dir, "clean.wav")
        noisy_path = joinpath(temp_dir, "noisy.wav")
        WAV.wavwrite(clean, clean_path; Fs=task.sample_rate, nbits=16, compression=WAV.WAVE_FORMAT_PCM)
        WAV.wavwrite(noisy, noisy_path; Fs=task.sample_rate, nbits=16, compression=WAV.WAVE_FORMAT_PCM)

        clean_bytes = filesize(clean_path)
        noisy_bytes = filesize(noisy_path)
        clean_sha = bytes2hex(sha256(read(clean_path)))
        noisy_sha = bytes2hex(sha256(read(noisy_path)))

        result = Dict{String,Any}(
            "contractVersion" => CONTRACT_VERSION,
            "algorithmVersion" => ALGORITHM_VERSION,
            "taskSha256" => task_sha256,
            "taskContractVersion" => task.contract_version,
            "taskAlgorithmVersion" => task.algorithm_version,
            "params" => Dict{String,Any}(
                "text" => task.text,
                "normalizedText" => task.normalized_text,
                "morseWords" => task.words,
                "wpm" => task.wpm,
                "toneHz" => task.tone,
                "sampleRateHz" => task.sample_rate,
                "snrDb" => task.snr,
                "seed" => task.seed,
                "rampMs" => task.ramp_ms,
            ),
            "environment" => Dict{String,Any}(
                "juliaVersion" => string(VERSION),
                "packages" => Dict{String,Any}(
                    "TyCommunication" => _pkg_version(TyCommunication),
                    "JSON3" => _pkg_version(JSON3),
                    "WAV" => _pkg_version(WAV),
                ),
            ),
            "seed" => task.seed,
            "exactDurationSeconds" => task.timeline.exact_duration,
            "durationSeconds" => task.timeline.duration,
            "sampleCount" => task.timeline.sample_count,
            "durationQuantizationErrorSeconds" => task.timeline.duration_error,
            "maxSampleQuantizationErrorSeconds" => task.timeline.max_error,
            "requestedSnrDb" => task.snr,
            "measuredSnrDb" => measured_snr,
            "snrDefinition" => task.snr === nothing ? nothing :
                "10*log10(sum(clean^2)/sum(noise^2)) over the whole message including gaps; noise via TyCommunication.awgn(clean, snr, \"measured\", seed)",
            "noiseVariance" => awgn_variance,
            "estimatedNoiseVariance" => estimated_variance,
            "normalizationGain" => gain,
            "peakClean" => peak_clean,
            "peakNoisy" => peak_noisy,
            "keyDownSegments" => [
                Dict{String,Any}("startSample" => start_sample, "endSample" => end_sample)
                for (start_sample, end_sample) in task.timeline.segments
            ],
            "artifacts" => Dict{String,Any}(
                "cleanWav" => Dict{String,Any}("path" => "clean.wav", "bytes" => clean_bytes, "sha256" => clean_sha),
                "noisyWav" => Dict{String,Any}("path" => "noisy.wav", "bytes" => noisy_bytes, "sha256" => noisy_sha),
            ),
            "unrecognizedTaskFields" => task.unrecognized_fields,
            "executionControl" => Dict{String,Any}(
                "interactive" => false,
                "transmits" => false,
                "mode" => "offline-simulation",
            ),
        )

        _write_result(joinpath(temp_dir, "result.json"), result)
        mv(temp_dir, output)
        published = true
        return result
    finally
        if !published && ispath(temp_dir)
            rm(temp_dir; recursive=true, force=true)
        end
    end
end

end # module
