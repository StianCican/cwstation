# run_task.jl — CWSignal 命令行入口。
#
# 用法：
#   julia run_task.jl <task.json> <outputDir>
#
# 也支持在 Syslab/REPL 中 `include("CWSignal.jl")` 后直接调用：
#   CWSignal.run_task(taskPath, outputDir)
#
# 命令行输出为单行 JSON：成功 {ok:true,...}，失败 {ok:false,code,error}。

include(joinpath(@__DIR__, "CWSignal.jl"))

using .CWSignal
using JSON3

function _main(args::Vector{String})
    if length(args) != 2
        println(JSON3.write(Dict("ok" => false, "code" => "usage", "error" => "usage: julia run_task.jl <task.json> <outputDir>")))
        return 2
    end
    try
        result = CWSignal.run_task(args[1], args[2])
        output = abspath(args[2])
        summary = Dict(
            "ok" => true,
            "method" => "run_task",
            "outputDir" => output,
            "resultPath" => joinpath(output, "result.json"),
            "sampleCount" => result["sampleCount"],
            "durationSeconds" => result["durationSeconds"],
            "requestedSnrDb" => result["requestedSnrDb"],
            "measuredSnrDb" => result["measuredSnrDb"],
            "keyDownSegmentCount" => length(result["keyDownSegments"]),
            "artifacts" => result["artifacts"],
        )
        println(JSON3.write(summary))
        return 0
    catch error
        if error isa CWSignalError
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
