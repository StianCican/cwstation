# V00-02-F Harmony 手机端实时解码检验器实施证据

## TONE-600 真机原地安装与启动（2026-10-29）

用户连接手机并要求本版调好后再做Android。当前只完成鸿蒙新版安装/启动，不提前实施Android或重开算法选型。

- HDC识别原目标22M0223928011053，读取原bundle后确认org.cwstation.decoder存在。修改前dirty补丁、四份状态文档和未跟踪benchmark副本保存于`.local-backups/harmony-tone-install-20261029-211544/`；旧签名HAP仍在上一轮`signing-project-before.tar`，未卸载或清数据。
- 本地待装HAP SHA256再次确认`2085048da762dbf5a78ed3ea90cb91c1d26ec705c2369c485b399adf6b6eb927`，Windows HDC `install -r`返回`install bundle successfully`；`aa start -a EntryAbility -b org.cwstation.decoder`返回`start ability successfully`。
- 前后UID均20020369、installTime均1793165831005，updateTime从1793165831005到1793276159383；版本仍0.1.0/1000000，所以版本号本身不能区分新旧算法。本地精确HAP安装命令/成功结果及更新时刻是本次部署证据，不宣称设备安装文件SHA核对。
- 启动后限定UI布局显示“准备接收”“0% / 峰值0%”“麦克风·本机处理”“开始接收”。未点击接收、未播放音频、未录音；新版手机600Hz声学准确性仍待用户试听，不能把启动成功当作解码质量通过。保留应用前台准备态供用户操作。
- 无产品源码改变，沿用最终离线/编译/验签证据，不机械重跑。无电台/RF/账本操作。安装/start日志、前后bundle和启动布局保留上述备份目录。下一步原15/20WPM600Hz标准音频同音量距离，安静/人声条件分别比较；Android只作为本版调好后的明确后续项。

下方“未连接/未安装”仅对应离线交付时刻，已由本段安装证据替代。


## TONE-600 v1：限定离线验收与试听包交付（2026-10-29）

用户已同意实施600 Hz目标音调前端；本轮离线验收完成，最终调试签名HAP已准备，手机HDC枚举为空，**尚未安装此新版，真机质量待验**。2026-10-28初版安装/采集/安静与人声截图计分仍有效。手机仅为只读算法检验器，不计入0.0自动发射验收；设备USB/RF任务暂停，未打开串口、采集麦克风或操作账本。

### 变化与主链

实际接入仍为原`OH_AudioCapturer → 有界队列 → 单一worker → CwDecoder → demod_morse`；在该C实现原整流包络前增加中心600 Hz、Q=5的RBJ二阶带通（中心增益1，约120 Hz带宽，中心群延迟约2.65ms）。状态归原decoder，随init复位，逐样本连续；无音频回调分配、无新线程或另一个Morse解码器。原时序估计、门限、迟滞、字符表和UI未修改。中心延迟小不等于零包络失真，真实声学效果待验。

唯一算法真源为原固定上游提交加`patches/multimon-ng/multimon-threshold-hysteresis.patch`。补丁新增编译期选项`CW_TARGET_TONE_HZ`，默认0；手机生产CMake及受影响采集host测试明确600，native对照分别编译0/600。桌面已运行的外部源码/二进制未替换。无新入口、服务、协议、依赖或持久化格式；使用工具链既有libm。手机实际ARM64 build.ninja及签名副本均核对有`CW_TARGET_TONE_HZ=600`，副本关键源码与主目录逐字节相同，不在副本开发。

### 同输入对照与最小回归

复现命令（输出目录必须不存在，路径用绝对路径；PATCHED_SOURCE须为固定上游加当前补丁）：

```bash
bash apps/harmony-cw/native/tests/run_tone_benchmark.sh OUTDIR PATCHED_SOURCE REFERENCE_DIR
bash apps/harmony-cw/tests/run_tests.sh
bash apps/harmony-cw/build.sh
```

本轮使用已有`data/cw-reference-20261028-145552`标准音频/135字符答案/scorer，不重新制作手机测试平台、不录音。结果：

| case | legacy CER % | 600 Hz CER % | delta pp | legacy edits | 600 edits |
|---|---|---|---|---|---|
| clean-15wpm | 0.741 | 0.741 | +0.000 | 1 | 1 |
| clean-20wpm | 0.000 | 0.000 | +0.000 | 0 | 0 |
| offset-590hz-20wpm | 0.000 | 0.000 | +0.000 | 0 | 0 |
| offset-610hz-20wpm | 0.000 | 0.000 | +0.000 | 0 | 0 |
| interferer-1000hz-20wpm | 100.000 | 0.000 | -100.000 | 135 | 0 |
| interferer-1500hz-20wpm | 100.000 | 0.000 | -100.000 | 135 | 0 |


1000/1500 Hz干扰是对同一20WPM PCM全段叠加峰值0.18的连续正弦，原CW峰值0.45，未截幅。旧版这两案输出34个非空格字符的错误片段（逐字符计分为34替换、101漏字，合计135编辑）；新版逐字正确。590/610 Hz用原signal编码/时间轴/包络重新合成同文；这些是合成探针，**不代表真实语音或手机准确率**。15WPM仍首V→X（1替换），未剔除开头错误；20WPM全段正确，未证实任何长期漂移问题。固定600 Hz本版不自动选频，明显偏离的音调会衰减，带内人声/噪声仍可能干扰。

`benchmark-final.log`及`bench-final/benchmark.json`记录完整命令/结果，exit0。宏0/600各自与同配置独立CLI逐字节一致；CQ TEST、有/无/合成尾静音、37样本/随机/单样本分块、单实例/clear/finish契约全部通过。`capture-host.log` exit0，实际生产capture_session/worker/decoder以600编译通过原故障/生命周期用例。新宏0与原既有harness的完整15/20WPM字节一致，保存译文与评分于`codex-check/`。从固定上游独立应用补丁后，两源码与手机逐字节相同（`projection-check/`）。不重跑设备/桌面/全仓测试。

### 构建与产物

- WSL最终未签名构建exit0，17s133ms；Windows既有隔离签名副本最终构建exit0，39s987ms。最后一轮仅同步包内源码来源说明，原生库SHA与前轮一致，无需重复算法回归。
- 最终签名包：`.local-backups/harmony-tone-20261029-021422/cw-decoder-600hz-final-signed.hap`，1542627字节，SHA256 `2085048da762dbf5a78ed3ea90cb91c1d26ec705c2369c485b399adf6b6eb927`。
- 最终未签名包：`.local-backups/harmony-tone-20261029-021422/cw-decoder-600hz-final-unsigned.hap`，SHA256 `b3526dd202b475c1f59057bedac99b521d726b4257d2ed52094d04a221c1c4cb`。两包均为ARM64；不同平台工具链构建的so散列分别保留，不把它们说成逐字节一致。
- SDK `verify-app`对最终签名包exit0，包内代码签名/摘要/权限签名验证通过；日志`verify-final-private.log`仅本地保留。首次验签误用`-outFile`参数exit1，查公开帮助后改为必需的`-outCertChain/-outProfile`通过，无签名密钥读取或复制。
- 包内`multimon-source.md`已与当前PROVENANCE逐字节一致，补丁SHA `e665984dd6d7e226bdfa9d64793ee8549a2fd8a407ee253683a2f8edfa6160dd`；无WAV/PCM测试音频。`final-artifacts.json`保留两HAP及原生库SHA、来源说明/源码同步核查。

### 审议、限制与保护

Codex设计和阶段自查、DSH实现及自查、Codex独立复核。DSH v1在全CLI构建阶段300秒超时（exit124），不计完整验收报告；v2只读审议exit0，源代码无S0/S1，指出完整对照尚未结束及来源说明旧叙述。随后Codex完成实际对照exit0并修正来源说明及包内副本；本节据最终证据收口。DSH报告中“清洁两档CER0/20WPM丢前导XV/无时序失真”等概括不准确，未采纳：独立评分为15WPM0.741%、20WPM0%，延迟不是零失真证明。不存在未解决的S0/S1。

| 检查 | 最终结论 |
|---|---|
| R01/R02/R13 | 通过：仅用户批准的第一项，原手机主链接入，同一补丁精确投影；无第二解码器/新入口/服务/真源 |
| R03 | 不适用数据迁移；编译选项默认0且保持旧输出，无运行时公共接口变更 |
| R04 | 通过限定离线：原采样格式门禁保留，双精度稳定滤波，输出限S16域，系数极点半径约0.983<1；仅使用0/600编译配置 |
| R05/R08 | 发射不适用；无新增权限/网络/录音，未启动手机采集 |
| R06/R07/R09 | 通过受影响host范围：原停止/队列/worker/生命周期契约通过，不外推真机底层资源释放 |
| R10 | 通过限定离线：同PCM、旧行为、CLI字节、分块、worker、HAP及验签；新版手机声学/长时未验 |
| R11 | 通过：Git干净基线79461d8，before.tar与signing-project-before.tar覆盖修改源码/旧构建/签名工作副本；未清理账本或原HAP |
| R12 | 通过：MEMORY/ROADMAP/任务/本证据更新；手机README及源码来源旧状态同步 |

S3保留：GCC提示`abs(int_fast32_t)`到int的潜在收窄，实际输入是S16或显式限S16后的滤波输出，范围[-32768,32767]，不存在该调用的值截断；这是类型告警，未隐藏为零告警。其他完整CLI上游告警不作为本轮新功能证明。普通`diff --check`会对补丁文件中新增的“上游上下文空行前缀”报告4处空白，已独立检查补丁可应用且投影一致；以临时`core.whitespace=-blank-at-eol`检查其余错误exit0，未改全局或仓库配置。

保护目录：`.local-backups/harmony-tone-20261029-021422/`。`before.tar`保存原手机源码/构建/补丁/状态文档，`signing-project-before.tar`保存原签名工作副本和旧HAP；Git基线79461d8。头次备份多复制DSH profiles依赖后停止了不必要的node_modules复制，原文件未修改，partial副本保留，headless配置另行完整保存。没有提交/推送。旧手机已安装版本不变。

下一步仅需连接已授权手机、覆盖安装最终签名HAP，用原600 Hz、15/20WPM同音量距离对照，观察原文及开头错误；安静/人声条件分别记，不录音。不自动推进第二项时序改进；手机未连接不重做既有初版安装验收。

---

以下为2026-10-28原任务历史证据，未安装等描述仅对应当时阶段。


日期：2026-10-28。作者：Codex；DSH负责host桥接、第一阶段设计复核及采集路径交叉审议/故障注入。状态：**限定离线交付，未签名HAP构建通过；真机未验、任务未整体关闭**。

## 用户目标、主链与修改边界

用户希望用手机麦克风检验现有CW算法，设备由用户报告为 Mate X5 / “鸿蒙7”，实际系统/API未读取；目前手机断开。只增加 `apps/harmony-cw` 的本地诊断入口：`Index.ets → N-API async work → CaptureSession → Native OH_AudioCapturer callback → 44100样本环形队列 → 单worker → cwstation::CwDecoder → 精确vendored demod_morse`。不接AI、网络、发射、设备账本或音频持久化，桌面/CLI的runReceive链、外部decoder工作树未改。新增一个HAP应用入口，无新服务进程/协议/持久化格式；不是0.0产品集成或替换。

## 保护与检查点

- 初始提交基线 `6711b59`；接续时已存在MEMORY修改、任务/首轮审议未跟踪文档，未覆盖这些成果。
- 实现前 `.local-backups/harmony-implementation-20261028-132057/` 保存原diff、MEMORY/任务/审议副本、ROADMAP修改前副本和新增路径边界。各轮修正前工程tar、测试目录副本也在此目录；新增应用目录此前不存在。
- 设计定稿：首轮F1-F6已修订；DSH定向复核无S0/S1阻塞，Codex核对后限定进入实现。原始结果 `dsh-result.log`，首轮审议原文保留并追加第二轮记录。
- 首链/交付合并审议：DSH只修改host测试目录，审议原始结果 `dsh-review-result.log`；Codex按发现修复并只回归受影响用例。无范围扩大/真实设备/外部服务接入，无须重复历史桌面/电台测试。
- 最终检查：变更只涉及手机应用及MEMORY/任务/审议/ROADMAP/本证据；构建产物、测试PCM、本地备份不入Git。未执行真实设备或模型，没有发射。

## 真实算法的主机对照

DSH从固定提交 `b5f7d71c5e9b5a76093ba55c515968dc40f92804` + 既有patch锁定投影，逐字节核对外部树；SHA见 `apps/harmony-cw/third_party/multimon-ng/PROVENANCE.md`。仅编译原demod_morse，不改算法；`_verbprintf`只捕获level0，单活动实例、64KiB UTF-8上限。

```bash
cmake -S apps/harmony-cw/native -B apps/harmony-cw/native/build \
  -DCMAKE_BUILD_TYPE=Release \
  -DCW_MULTIMON_CLI=/home/li0214/DSH/tools/multimon-ng-v00-02/build/multimon-ng
cmake --build apps/harmony-cw/native/build --parallel 2
ctest --test-dir apps/harmony-cw/native/build -V
```

DSH执行：构建通过，CTest 1/1 passed。证据沿用 `native/build/logs/ctest.log`，Codex核对命令/对象/结果，未机械重跑。临时向量由根项目现有signal合成能力生成22050 Hz mono S16LE CQ TEST。带尾静音输出字节 `43 51 20 54 45 53 54 20 0a`，无尾静音 `43 51 20 54 45 53 0a`；与patched CLI逐字节一致。默认bridge补0.5秒静音等同CLI带尾文件；37样本/单样本/确定性随机分块一致。覆盖第二实例拒绝、析构后再建、clear不重置时序、finish幂等及finish后feed拒绝。不是麦克风/空口质量证据。

## 采集路径故障注入与审议修正

```bash
bash apps/harmony-cw/tests/run_tests.sh
```

DSH首次执行通过；Codex修正后最终执行exit0。`tests/build/host-test.log` 与备份目录 `capture-final-tests.log` 保存最终输出。测试编译实际生产 `capture_session.cpp`、实际CwDecoder和原C算法，仅OH_Audio接口替换为fake；不执行N-API/ArkTS或系统音频。

覆盖实际格式不符/Start失败后的释放与重试、CQ TEST进入真实worker/decoder并在stop完整收尾、停止后重启、Stop失败抛错、Release失败保留userdata/迟到回调忽略/再次释放。新增回归覆盖成功重试清除旧native错误、被取消start在创建资源前拒绝、旧stop代次不释放新session、Destroy连续失败保留builder并阻断覆盖直到显式清理。

DSH发现的S2及Codex处置：

| 发现 | 最终处置与证据 |
|---|---|
| stop成功后旧错误残留；UI可能无限自动stop重试 | cleanup成功清native错误，UI保留单独lastError诊断；每次启动的错误自动停止至多一次，失败后由用户按钮显式重试；native重试状态回归通过，UI分支静态核对/编译通过，真机未验 |
| superseded start假成功；旧stop可能停掉新start | start过期明确抛错，stop携带epoch并跳过过期代次；UI以drain状态展示；host代次回归通过 |
| finalizer无区别保活；builder可能覆盖；deferred队列失败 | 仅资源仍保留时保活原Owner，避免额外分配；线程启动失败留存userdata，不在GC线程join；检查instance/properties注册；builder纳入start占用门禁，队列失败reject原Promise；builder回归通过，N-API仅静态/SDK编译核对 |
| 文档实施证据链接缺失 | 本文件补齐，MEMORY/任务/审议/ROADMAP同步 |

额外修正：权限弹窗返回后核对页面可见/前台状态，后台stop使排队启动失效；后台/销毁显式异步stop，音频回调不调用N-API或采集API。不按超时强行销毁可能仍被系统调用的对象；系统Stop/Release若阻塞，异步Promise可能保持pending，真机观察仍是门槛。Release持续失败时资源保留到显式重试或进程退出，不伪报正常stopped。

## HAP构建与包核对

```bash
bash apps/harmony-cw/build.sh
```

最终构建exit0，`BUILD SUCCESSFUL in 10 s 364 ms`；CLT 26.0.0.851 / SDK 26.0.0.105，Hvigor 6.26.8。最终日志 `.local-backups/harmony-implementation-20261028-132057/hap-verified-build.log`。ArkTS、ARM64原生库与HAP打包通过；打包器明确警告没有signingConfig，**未签名**。

产物：`apps/harmony-cw/entry/build/default/outputs/default/entry-default-unsigned.hap`，1472157字节，SHA256 `551e54c92bf21994aac04b086f4c4611257fdb6d386078a478fab819fd3cc73f`。

包内检查包含 `libs/arm64-v8a/libcwdecoder.so`、`ets/modules.abc`、manifest及GPL/cJSON/源码来源声明；没有.wav/.s16le/.pcm测试音频。原生库为AArch64 ELF。应用及对应源码按GPL-2.0-or-later，未对外分发；构建脚本、许可证、SHA及源码投影随工程保留。不将unsigned HAP称为可直接安装或运行通过。

## R01–R13最终限定复核

| R | Codex最终结果 |
|---|---|
| R01 | 通过：手机只读检验器，用户目标一致 |
| R02 | 通过：同一C算法薄桥接，桌面主链不变 |
| R03 | 不适用协议/持久化迁移；许可证/源码和构建说明已提供，未分发 |
| R04 | 通过（host/编译）：严格格式门禁、队列/文本上限，真实支持待验 |
| R05 | 不适用：无发射/台站设备执行 |
| R06 | 通过（host）：释放/收尾/失败抛错与重试；系统阻塞与物理释放待验 |
| R07 | 通过（host/静态）：队列有界、代次与串行生命周期；N-API/UI实际运行未验 |
| R08 | 通过声明/编译核对；权限拒绝/批准与后台实际行为未验 |
| R09 | 通过（host/静态）：失败保活/重试、清理与builder门禁；GC/系统音频未验 |
| R10 | 通过限定离线范围；不构成真机或解码质量验收 |
| R11 | 通过：既有dirty基线与每轮修正副本可恢复 |
| R12 | 通过：本证据及任务/记忆/路线同步，真机状态明确 |
| R13 | 通过：一个明确只读手机入口，复用既有算法，无第二产品服务/协议/记录真源 |

## 仍需手机的下一步

电脑端可以交付未签名构建，真机阶段尚未开始。需要用户再次连接Mate X5后，先确认HDC可见与调试授权、读取真实系统/API和签名安装条件，再准备合适签名。安装后验权限拒绝/批准、实际22050格式、电平/原文、停止/再次开始、退后台和音频中断；最后用已知电文及真实CW判断误码/漏字/延迟。尚无任何真机安装/麦克风/现场质量通过证据；本轮不推送、不发布、不自动发射。

## 真机接续：HDC识别通过，签名待办（2026-10-28）

用户连接Mate X5后，Windows PnP显示HUAWEI Mate X5与HDC Interface。WSL SDK HDC list为空；既有Windows DevEco SDK hdc.exe显式选中USB目标后读取：ALT-AL10、OpenHarmony-7.0.0.111、系统7.0.0.111(SP13C00E111R6P2)、API26、aarch64。与当前ARM64/API26构建一致；未做USB透传/驱动安装。

仅检查既有调试profile的公开bundle/type/有效期元数据，绑定com.example.smartsuitcase，不匹配当前org.cwstation.decoder，不能挪用；未读取/复制现有私钥或账号凭据。当前需要在DevEco为本包和本设备生成调试签名。为避免签名密码/配置进入源码，已在 `.local-backups/harmony-device-20261028-135449/signing-project` 复制无构建/无凭据的源码工作副本，专用于IDE自动签名和打包；主源码仍为apps/harmony-cw。当前未安装、未启动应用、未采集音频。

### 自动签名接续检查

用户报告自动签名已完成后，仅解析CW源码工程/签名副本的配置结构和配置项名称（不输出密码），两者signingConfigs均为空，default产品尚无signingConfig。DevEco原主窗口为旧harmonyos-build，尚不能认为本包签名生成。重新用Windows启动器打开精确signing-project路径后，IDE日志确认工程加载/索引完成，Windows UI窗口枚举存在signing-project。此前未确认切窗成功，是本次接续缺口。

准备自动打开签名页面的Windows界面脚本被安全软件以ScriptContainedMaliciousContent拦截；未尝试绕过、关闭防护或改用规避手段。需用户在已打开的signing-project窗口完成Project Structure/Signing Configs。本轮未签名、未安装、未启动CW应用；手机仍由Windows HDC识别。状态修改前副本保留在同一harmony-device目录。

## 调试签名构建完成，等待设备重新上线（2026-10-28）

用户完成正确工程的自动签名后，配置中已有default/HarmonyOS签名材料，profile公开元数据的bundle为org.cwstation.decoder、debug/1台设备。product未绑定签名；Codex在隔离副本备份原build-profile后绑定default。标准Windows DevEco ohpm/Hvigor构建，无需读取或传递明文密码；配置/原始日志均在Git忽略目录，不输出签名秘密。关键C++/ArkTS/原算法源码SHA与主工程一致。

Windows构建 `BUILD SUCCESSFUL in 51 s 696 ms`，exit0；日志仅本地 `build-signed-private.log`。产物：`.local-backups/harmony-device-20261028-135449/signing-project/entry/build/default/outputs/default/entry-default-signed.hap`，1543402字节；SHA256 `d5986a482ec7868bc3db530671be1ab251da82753ff912dcc36f012d81607536`。包内ARM64原生库与ArkTS存在，无测试音频。

SDK hap-sign-tool verify-app最初命令因outCertChain参数大小写拒绝，未开始校验；修正后exit0，输出verify codesign success、Digest verify result true/SHA-256、verify permission sign success和verify-app success。日志 `signature-verification/verify-corrected.log`；不把构建成功单独当验签。

当前手机由USB Offline变为HDC列表无USB目标；定向reconnect报目标不可用，重启电脑端HDC服务后仍无手机。未执行设备重启、root、系统配置变更、安装或启动，也未采集音频。需用户重插USB、解锁并允许调试授权，再继续安装已签名HAP。应用安装/权限/实际音频格式/后台释放/解码质量依然未验。

### USB断线定向诊断（用户再次确认重连后）

HDC客户端/服务端版本均3.2.0f，无版本不一致；主机服务仅一份。仅定向读取Windows HDC连接日志、过滤握手/USB传输失败，未读取密钥。14:14:08日志有Session handshake successful、daemonauthstatus=SUCCESS；14:14:11 USB bulk ReadPipe/WritePipe失败并释放会话，后续有device no longer connected及invalid descriptor。当前列表再次USB Offline。说明调试授权曾成功，USB数据通道随后失败；尚不能唯一断定线缆或端口根因。建议直连另一个USB接口，必要时换已知可传数据的线。没有重复生成签名、没有修改驱动/手机系统、没有执行安装或音频操作。状态与证据修改前副本在同一harmony-device目录。

### 换口后复核与最小下一动作

用户确认换口后，HDC仍USB Offline。电脑端HDC重枚举后无USB目标，Windows仍显示Mate X5与HDC Interface。PnP属性：Service WinUSB、ProblemCode0、驱动包oem22.inf；仅一份hdc.exe，客户端/服务端3.2.0f。当前日志持续DetectMyNeed OpenDeviceMyNeed childRet:-100；该返回码具体内部含义未确认，不能按Win32/USB标准错误码直接解释，也不据此唯一归因线缆。

DSH只读快速诊断结果 `.local-backups/harmony-device-20261028-135449/dsh-usb-diagnosis.log` 已复核：卡在发现/打开USB目标阶段，签名包不需重建。历史14:14:08授权成功与随后传输失败证据保留；当前日志是重启后的新时段，没有授权记录不能推翻历史。未读取密钥、未改驱动、未执行手机重启/root/USB透传。需要用户在手机关闭再打开USB调试以重建手机端接口；当前仍未安装/运行应用。

### USB调试开关后深入定位（2026-10-28 14:29–14:31）

用户已关闭/开启USB调试，HDC仍无USB目标。临时提高电脑端HDC日志至DEBUG，为获得此前INFO缺失的底层返回码：14:29:09及14:29:42均出现`libusb_open fail xret -5`，外层仍`childRet:-100`。公开OpenHarmony developtools_hdc master的src/common/define_enum.h确认ERR_LIBUSB_OPEN=-100；host_usb.cpp在libusb_open失败分支返回它。源码不是已安装二进制的精确提交，结合日志作为路径佐证。libusb -5为ERROR_NOT_FOUND，不与-4 ERROR_NO_DEVICE混淆。

Windows当前USB\VID_12D1&PID_1101&MI_00接口ProblemCode0/WinUSB。读取oem22.inf，内容为libwdi通用WinUSB INF、USB_Install.HW采用NoDeviceInterfaceGUID；当前实例Device Parameters读取DeviceInterfaceGUIDs/DeviceInterfaceGUID均无值。作为注册/驱动层线索，未证明它是唯一根因；历史成功握手仍有效。未写注册表、未安装/删除驱动。

下一最小恢复动作是只重启该HDC接口：普通权限pnputil /restart-device明确拒绝访问；已通过Windows正常RunAs流程发起同一命令，等待用户UAC确认及进程返回。没有自动操作安全确认、没有绕过此前安全软件拦截。尚未得到接口重启成功证据，尚未安装/启动CW应用。文档修改前副本及dirty补丁在`.local-backups/harmony-usb-debug-20261028-143051/`；源代码/HAP未改，不重跑已通过的离线测试。

### 接口重启完成，GUID补充修复准备（2026-10-28 14:33–14:36）

用户完成前次UAC，接口restart进程exit0，但HDC仍无USB目标，-5持续。Windows活跃HDC实例/WinUSB不变；Device Parameters属性名仅VendorRevision、RevisionId、ExtPropDescSemaphore，无GUID值。

DSH USB-REG-REVIEW-01 exit0，只读审议确认WinUSB在加载时读取该硬件键的DeviceInterfaceGUIDs并注册路径，libusb读取同一键枚举。提出-5不同于缺GUID读取处的-3、需直接DEBUG探针；Codex采纳，未凭-5直接宣布根因。微软文档 https://learn.microsoft.com/en-us/windows-hardware/drivers/usbcon/winusb-installation 明确允许在现有WinUSB实例手动补GUID、重连加载。DSH日志在本轮保护目录；不计修复成功或手机验收。

HDC前台LIBUSB_DEBUG未输出libusb底层细节，故停HDC后用Windows现有Python ctypes调用相同libusb_shared.dll的公开API，仅枚举/读取descriptor/打开并关闭设备，不claim/传输。枚举11个设备，Huawei PID1101，OPEN -5；DEBUG出现多处no DeviceInterfaceGUID registered（未逐条绑定到Huawei，结合注册表为支持证据）。PowerShell将native stderr记为错误使命令exit1，但Python有完整probe/清理输出；不记为命令exit0。原始probe-libusb.log保留本地。

最小受控修复已准备并发起UAC：验证活跃精确实例/WinUSB，确认原GUID不存在；reg export成功后才添加新随机GUID（REG_MULTI_SZ）；只重启HDC子接口。脚本若AccessDenied即停止，不改ACL/所有者。回退脚本只在值仍等于本次GUID时删除，再重启；原键导出保留。当前等待修复结果，未更换驱动包/修改应用/安装手机HAP。保护目录`.local-backups/harmony-usb-interface-20261028-143300/`，已保存修改前MEMORY/证据/dirty补丁。

### USB恢复、签名HAP安装与初始页面通过（2026-10-28 14:36–14:38）

首次repair-interface.ps1在reg export成功后因PowerShell5.1 Set-Content不支持-NoClobber退出1，尚未写注册表。保留原脚本/日志/原键导出，改用New-Item无覆盖创建GUID记录文件，另用v2日志与v2原键导出；第二次正常UAC执行exit0/REPAIR_COMPLETED。新增DeviceInterfaceGUIDs={a327a97e-f457-4ac8-ba97-8ebc9449ca4c}，类型MultiString，设备其余三个原属性保留；pnputil明确接口重启成功。未改ACL/所有者/驱动包/手机系统。HDC重新启动以枚举新接口后立即USB Connected，说明本次补充解决了当前可观察的打开阻塞，不据此唯一解释历史ReadPipe异常。

使用既有Windows HDC显式目标22M0223928011053安装原已签名HAP，返回install bundle successfully / AppMod finish，进程exit0。再次核对本地产物SHA256仍d5986a482ec7868bc3db530671be1ab251da82753ff912dcc36f012d81607536。随后aa start -a EntryAbility -b org.cwstation.decoder返回start ability successfully；pidof返回63797。没有更改应用或重建包。

uitest dumpLayout -b org.cwstation.decoder仅获取本应用窗口，phone-initial.json确认CW / LIVE、准备接收、0%/峰值0%、麦克风·本机处理、开始接收及原文占位语；初始ArkTS/N-API加载未见页面异常。已请用户手动开始并批准麦克风权限；当前尚未取得采集启动、真实22050格式、停止/后台释放或CW正确性证据。所有本轮资料在`.local-backups/harmony-usb-interface-20261028-143300/`，文档/dirty基线也保存在该目录。

### 真机基础采集与生命周期观察（2026-10-28）

用户手动开始后phone-current.json显示正在接收、MIC·22050 Hz·单声道·S16LE·RAW、峰值1%及原始译文；随后before-v2布局电平22%/峰值32%，持续产生文本。实际音频格式由production capture Get*严格校验后写UI，证明通过本机格式门禁和实际解码输出，不证明译文准确。未知声源不作已知报文正确性验收。未录制/持久化音频。

明确停止点击后phone-stopped.json及stop-v3.json显示已停止·可再次开始、0%/峰值0%、开始接收。再次开始后的phone-boundary.json显示正在接收和新增文本。自动脚本早期v1/v2基于状态假设失败（窗口状态变化，未归因用户）；v3停止成功，紧接重启的bundle限定布局暂空导致断言失败，后续直接布局确认同PID63797仍正常接收，不能把脚本exit1称为全程通过。单独执行Home再aa start，phone-background-final.json确认已停止/开始接收/0%，最终留停止。返回时文本占位恢复，未把该现象当译文持久化通过；当前本来无持久化要求。

已安装bundle dump确认org.cwstation.decoder 0.1.0/versionCode1000000、debug、libs/arm64及系统entry.hap路径；读取该系统HAP的sha256sum被Permission denied，主机HDC进程退出码0不等于子命令成功。目标文件散列不可读限制明确保留，以本地已验签精确路径安装成功/版本/进程/界面证明安装与启动，不声称目标散列核对通过。

限定结论：安装/启动、MIC严格格式、电平/原文、停止/再次开始与退后台后UI停止已观察；没有独立音频服务dump证明资源释放、拒绝权限/音频中断/长时稳定性、已知报文误码/漏字/延迟尚未验收。应用当前留停止。源码/包未修改；本轮仅USB单实例注册修复和状态证据更新，保护见本节前述目录，原键及仅删除匹配新增值的回退脚本均保留。
