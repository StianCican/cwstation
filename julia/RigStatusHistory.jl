# RigStatusHistory.jl — MWORKS/Julia offline analysis of rig-statusd JSONL.
#
# This module never opens a serial port, IPC endpoint, database, or audio device.
# It consumes only the versioned read-only history emitted by rig-statusd.

module RigStatusHistory

using JSON3
using SHA
using Statistics

export analyze_history, RigStatusHistoryError

const HISTORY_SCHEMA_VERSION = 1
const ANALYSIS_VERSION = "1.0.0"
const MAX_INPUT_BYTES = 8 * 1024 * 1024
const MAX_LINE_BYTES = 64 * 1024
const MAX_RECORDS = 100_000
const KNOWN_EVENTS = Set(["service_start", "snapshot", "fault", "reconnect", "service_stop"])

struct RigStatusHistoryError <: Exception
    code::String
    message::String
end

Base.showerror(io::IO, error::RigStatusHistoryError) = print(io, error.code, ": ", error.message)

_fail(code::AbstractString, message::AbstractString) = throw(RigStatusHistoryError(String(code), String(message)))

function _require_number(value, name::AbstractString)
    value isa Real && !(value isa Bool) && isfinite(value) || _fail("invalid_record", "$name must be finite")
    Float64(value)
end

function _require_int(value, name::AbstractString)
    number = _require_number(value, name)
    isinteger(number) || _fail("invalid_record", "$name must be an integer")
    Int64(number)
end

function _increment!(counts::Dict{String,Int}, key::String)
    counts[key] = get(counts, key, 0) + 1
end

function _validate_record(value, line_number::Int)
    value isa JSON3.Object || _fail("invalid_record", "line $line_number must be a JSON object")
    get(value, :schemaVersion, nothing) == HISTORY_SCHEMA_VERSION ||
        _fail("unsupported_schema_version", "line $line_number has unsupported schemaVersion")
    recorded_at = _require_int(get(value, :recordedAt, nothing), "line $line_number recordedAt")
    event_value = get(value, :event, nothing)
    event_value isa AbstractString || _fail("invalid_record", "line $line_number event must be a string")
    event = String(event_value)
    event in KNOWN_EVENTS || _fail("invalid_record", "line $line_number has unknown event $event")

    report = get(value, :report, nothing)
    report isa JSON3.Object || _fail("invalid_record", "line $line_number report must be an object")
    get(report, :source, nothing) == "rig-statusd" || _fail("invalid_record", "line $line_number source is not rig-statusd")
    get(report, :readOnly, nothing) === true || _fail("invalid_record", "line $line_number readOnly must be true")
    status_value = get(report, :status, nothing)
    status_value isa AbstractString || _fail("invalid_record", "line $line_number status must be a string")
    status = String(status_value)
    status in ("disconnected", "connecting", "ready", "stale", "fault") ||
        _fail("invalid_record", "line $line_number has unknown status $status")
    stale = get(report, :stale, nothing)
    stale isa Bool || _fail("invalid_record", "line $line_number stale must be boolean")

    snapshot = get(report, :snapshot, nothing)
    frequency = nothing
    mode = nothing
    snapshot_time = nothing
    if snapshot !== nothing
        snapshot isa JSON3.Object || _fail("invalid_record", "line $line_number snapshot must be an object or null")
        frequency = _require_number(get(snapshot, :frequencyHz, nothing), "line $line_number frequencyHz")
        mode_value = get(snapshot, :mode, nothing)
        mode_value isa AbstractString || _fail("invalid_record", "line $line_number mode must be a string")
        mode = String(mode_value)
        _require_int(get(snapshot, :filter, nothing), "line $line_number filter")
        snapshot_time = _require_int(get(snapshot, :snapshotTime, nothing), "line $line_number snapshotTime")
    end
    return (
        recorded_at=recorded_at,
        event=event,
        status=status,
        stale=stale,
        frequency=frequency,
        mode=mode,
        snapshot_time=snapshot_time,
    )
end

function _write_result(path::AbstractString, result)
    output = abspath(path)
    parent = dirname(output)
    isdir(parent) || _fail("output_parent_missing", "output parent directory does not exist: $parent")
    ispath(output) && _fail("output_exists", "refusing to overwrite existing file: $output")
    temp_path, io = mktemp(parent; cleanup=false)
    published = false
    try
        JSON3.write(io, result)
        write(io, '\n')
        close(io)
        mv(temp_path, output)
        published = true
    finally
        isopen(io) && close(io)
        !published && ispath(temp_path) && rm(temp_path; force=true)
    end
    return output
end

"""
    analyze_history(history_path, output_path)

Validate a rig-statusd schema-1 JSONL file and write a new JSON summary. The
result is deterministic for the same input bytes except for environment data.
"""
function analyze_history(history_path::AbstractString, output_path::AbstractString)
    input = abspath(history_path)
    isfile(input) || _fail("history_not_found", "history file not found: $input")
    bytes = read(input)
    length(bytes) <= MAX_INPUT_BYTES || _fail("history_too_large", "history exceeds $MAX_INPUT_BYTES bytes")
    input_sha256 = bytes2hex(sha256(bytes))

    event_counts = Dict{String,Int}()
    status_counts = Dict{String,Int}()
    mode_counts = Dict{String,Int}()
    frequencies = Float64[]
    snapshot_times = Int64[]
    records = 0
    stale_count = 0
    frequency_changes = 0
    mode_changes = 0
    previous_frequency = nothing
    previous_mode = nothing
    previous_snapshot_recorded_at = nothing
    max_snapshot_gap_ms = 0
    first_recorded_at = nothing
    last_recorded_at = nothing

    for (line_number, line) in enumerate(split(String(bytes), '\n'))
        isempty(line) && continue
        ncodeunits(line) <= MAX_LINE_BYTES || _fail("history_line_too_large", "line $line_number exceeds $MAX_LINE_BYTES bytes")
        records += 1
        records <= MAX_RECORDS || _fail("history_too_large", "history exceeds $MAX_RECORDS records")
        value = try
            JSON3.read(line)
        catch error
            _fail("invalid_json", "line $line_number is not valid JSON: $(sprint(showerror, error))")
        end
        record = _validate_record(value, line_number)
        _increment!(event_counts, record.event)
        _increment!(status_counts, record.status)
        first_recorded_at = first_recorded_at === nothing ? record.recorded_at : min(first_recorded_at, record.recorded_at)
        last_recorded_at = last_recorded_at === nothing ? record.recorded_at : max(last_recorded_at, record.recorded_at)

        if record.frequency !== nothing
            record.event == "snapshot" && record.stale && (stale_count += 1)
            frequency = record.frequency::Float64
            push!(frequencies, frequency)
            record.mode !== nothing && _increment!(mode_counts, record.mode::String)
            record.snapshot_time !== nothing && push!(snapshot_times, record.snapshot_time::Int64)
            previous_frequency !== nothing && previous_frequency != frequency && (frequency_changes += 1)
            previous_mode !== nothing && previous_mode != record.mode && (mode_changes += 1)
            previous_frequency = frequency
            previous_mode = record.mode
            if previous_snapshot_recorded_at !== nothing
                max_snapshot_gap_ms = max(max_snapshot_gap_ms, record.recorded_at - (previous_snapshot_recorded_at::Int64))
            end
            previous_snapshot_recorded_at = record.recorded_at
        end
    end

    duration_ms = first_recorded_at === nothing ? 0 : last_recorded_at - first_recorded_at
    summary = Dict{String,Any}(
        "recordCount" => records,
        "snapshotCount" => length(frequencies),
        "staleRecordCount" => stale_count,
        "durationSeconds" => duration_ms / 1000,
        "eventCounts" => event_counts,
        "statusCounts" => status_counts,
        "modeCounts" => mode_counts,
        "frequencyHz" => isempty(frequencies) ? nothing : Dict{String,Any}(
            "minimum" => minimum(frequencies),
            "maximum" => maximum(frequencies),
            "mean" => mean(frequencies),
            "first" => first(frequencies),
            "last" => last(frequencies),
            "changeCount" => frequency_changes,
        ),
        "modeChangeCount" => mode_changes,
        "maxSnapshotGapSeconds" => max_snapshot_gap_ms / 1000,
        "firstRecordedAt" => first_recorded_at,
        "lastRecordedAt" => last_recorded_at,
    )
    result = Dict{String,Any}(
        "analysisVersion" => ANALYSIS_VERSION,
        "historySchemaVersion" => HISTORY_SCHEMA_VERSION,
        "input" => Dict{String,Any}(
            "path" => input,
            "bytes" => filesize(input),
            "sha256" => input_sha256,
        ),
        "summary" => summary,
        "environment" => Dict{String,Any}(
            "juliaVersion" => string(VERSION),
            "packages" => Dict{String,Any}("JSON3" => string(pkgversion(JSON3))),
        ),
        "executionControl" => Dict{String,Any}(
            "interactive" => false,
            "transmits" => false,
            "mode" => "offline-history-analysis",
        ),
    )
    _write_result(output_path, result)
    return result
end

end # module
