import { UIAbility } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import decoder from 'libcwdecoder.so';

export default class EntryAbility extends UIAbility {
  onWindowStageCreate(stage: window.WindowStage): void {
    stage.loadContent('pages/Index').catch(() => {});
  }
  onForeground(): void {
    AppStorage.setOrCreate('cwForeground', true);
  }
  onBackground(): void {
    AppStorage.setOrCreate('cwForeground', false);
    decoder.stop().catch(() => {});
  }
  onDestroy(): void {
    AppStorage.setOrCreate('cwForeground', false);
    decoder.stop().catch(() => {});
  }
}
