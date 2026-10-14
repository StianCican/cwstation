# analyze_history.jl — Julia/MWORKS CLI for read-only rig-statusd history.
#
# Usage: julia-ty.bat analyze_history.jl <history.jsonl> <analysis.json>

include(joinpath(@__DIR__, "RigStatusHistory.jl"))

using .RigStatusHistory
using JSON3

function _main(args::Vector{String})
    if length(args) != 2
        println(JSON3.write(Dict("ok" => false, "code" => "usage",
            "error" => "usage: julia analyze_history.jl <history.jsonl> <analysis.json>")))
        return 2
    end
    try
        result = RigStatusHistory.analyze_history(args[1], args[2])
        summary = result["summary"]
        println(JSON3.write(Dict(
            "ok" => true,
            "method" => "analyze_history",
            "outputPath" => abspath(args[2]),
            "inputSha256" => result["input"]["sha256"],
            "recordCount" => summary["recordCount"],
            "snapshotCount" => summary["snapshotCount"],
            "frequencyChangeCount" => summary["frequencyHz"] === nothing ? 0 : summary["frequencyHz"]["changeCount"],
            "modeChangeCount" => summary["modeChangeCount"],
            "transmits" => false,
        )))
        return 0
    catch error
        if error isa RigStatusHistoryError
            println(JSON3.write(Dict("ok" => false, "code" => error.code, "error" => error.message)))
            return 2
        end
        println(JSON3.write(Dict("ok" => false, "code" => "internal", "error" => sprint(showerror, error))))
        return 1
    end
end

if abspath(PROGRAM_FILE) == abspath(@__FILE__)
    exit(_main(ARGS))
end
