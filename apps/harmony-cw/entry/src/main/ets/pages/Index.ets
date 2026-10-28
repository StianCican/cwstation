import { abilityAccessCtrl, common } from '@kit.AbilityKit';
import decoder from 'libcwdecoder.so';

@Entry
@Component
struct Index {
  @State private transcript: string = '';
  @State private status: string = '准备接收';
  @State private running: boolean = false;
  @State private busy: boolean = false;
  @State private level: number = 0;
  @State private peak: number = 0;
  @State private dropped: number = 0;
  @State private truncated: number = 0;
  @State private lastError: string = '';
  private errorStopRequested: boolean = false;
  @State private format: string = '麦克风 · 本机处理';
  private timer: number = -1;
  private visible: boolean = false;

  aboutToAppear(): void {
    this.visible = true;
    this.timer = setInterval(() => this.refresh(), 150);
  }
  aboutToDisappear(): void {
    this.visible = false;
    clearInterval(this.timer);
    decoder.stop().catch(() => {});
  }
  private refresh(): void {
    const data = decoder.drain();
    if (data.text.length > 0) {
      this.transcript += data.text;
      if (this.transcript.length > 32768) {
        this.transcript = this.transcript.slice(-32768);
        this.truncated++;
      }
    }
    this.running = data.running;
    this.level = Math.min(100, Math.round(data.level * 100));
    this.peak = Math.min(100, Math.round(data.peak * 100));
    this.dropped = data.droppedSamples;
    this.truncated = Math.max(this.truncated, data.truncated);
    if (data.format.length > 0) this.format = data.format;
    if (data.error.length > 0) {
      this.lastError = data.error;
      if (data.running) this.status = data.error;
      if (data.running && !this.busy && !this.errorStopRequested) {
        this.errorStopRequested = true;
        this.end();
      }
    } else if (!this.busy && this.status === '正在接收' && !data.running) {
      this.status = '已停止 · 可再次开始';
    }
  }
  private async begin(): Promise<void> {
    this.busy = true;
    try {
      const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
      const result = await abilityAccessCtrl.createAtManager().requestPermissionsFromUser(context,
        ['ohos.permission.MICROPHONE']);
      if (result.authResults.length !== 1 || result.authResults[0] !== 0) {
        this.status = '需要麦克风权限才能接收';
        return;
      }
      if (!this.visible || AppStorage.get<boolean>('cwForeground') !== true) {
        this.status = '应用已离开前台，请返回后重新开始';
        return;
      }
      await decoder.start();
      this.errorStopRequested = false;
      this.lastError = '';
      this.refresh();
      this.status = this.running ? '正在接收' : '启动请求已取消';
    } catch (error) {
      this.status = '启动失败：' + String(error);
      this.lastError = this.status;
    } finally {
      this.busy = false;
      this.refresh();
    }
  }
  private async end(): Promise<void> {
    this.busy = true;
    this.status = '正在停止…';
    try {
      await decoder.stop();
      this.status = '已停止 · 可再次开始';
    } catch (error) {
      this.status = '停止异常：' + String(error);
      this.lastError = this.status;
    } finally {
      this.busy = false;
      this.refresh();
    }
  }
  build() {
    Column({ space: 18 }) {
      Row() {
        Text('CW / LIVE').fontSize(14).fontColor('#65DFBB').fontWeight(FontWeight.Bold)
        Blank()
        Text('离线解码').fontSize(12).fontColor('#A7BFBD')
      }.width('100%')
      Text('听见电码，看到原文').fontSize(27).fontWeight(FontWeight.Bold)
        .fontColor('#F0F5EE').width('100%')
      Text(this.status).fontSize(14).fontColor(this.running ? '#65DFBB' : '#CED5CE').width('100%')
      Column({ space: 8 }) {
        Row() {
          Text('输入电平').fontSize(13).fontColor('#A7BFBD')
          Blank()
          Text(this.level + '%  / 峰值 ' + this.peak + '%').fontSize(12).fontColor('#A7BFBD')
        }.width('100%')
        Progress({ value: this.level, total: 100, type: ProgressType.Linear })
          .color('#65DFBB').backgroundColor('#30484B').width('100%')
        Text(this.format).fontSize(11).fontColor('#A7BFBD').width('100%')
      }.padding(16).backgroundColor('#18383D').borderRadius(16)
      Row() {
        Text('原始译文').fontSize(15).fontColor('#F0F5EE')
        Blank()
        Button('清屏').fontSize(12).backgroundColor('#28474B').onClick(() => {
          decoder.clear(); this.transcript = ''; this.truncated = 0;
        })
      }.width('100%')
      Scroll() {
        Text(this.transcript.length > 0 ? this.transcript : '让手机靠近 CW 扬声器，然后开始接收。')
          .fontSize(23).fontFamily('monospace').fontColor(this.transcript.length > 0 ? '#F0F5EE' : '#789A9A')
          .lineHeight(34).width('100%').copyOption(CopyOptions.InApp)
      }.layoutWeight(1).width('100%').align(Alignment.TopStart)
        .padding(18).backgroundColor('#0A2328').borderRadius(16)
      if (this.dropped > 0 || this.truncated > 0) {
        Text('采集丢样：' + this.dropped + ' · 文本截断：' + this.truncated)
          .fontSize(12).fontColor('#FFD192').width('100%')
      }
      Button(this.busy ? '正在处理…' : (this.running ? '停止接收' : '开始接收'))
        .width('100%').height(52).fontSize(17).fontWeight(FontWeight.Bold)
        .fontColor('#0B292D').backgroundColor(this.running ? '#FFD192' : '#65DFBB')
        .enabled(!this.busy).onClick(() => {
          if (this.running) this.end(); else this.begin();
        })
      if (this.lastError.length > 0) {
        Text(this.lastError).fontSize(12).fontColor('#FFD192').width('100%')
      }
      Text('译文保留算法原始输出，未作补全或纠错。').fontSize(11).fontColor('#A7BFBD')
    }.padding({ left: 22, right: 22, top: 36, bottom: 24 })
      .width('100%').height('100%').backgroundColor('#102D32')
  }
}
