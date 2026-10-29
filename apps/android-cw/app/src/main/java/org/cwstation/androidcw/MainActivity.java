package org.cwstation.androidcw;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.AudioManager;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.WindowInsets;
import android.graphics.Insets;
import android.widget.Button;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Single-screen Android CW receive checker.
 *
 * <p>The capture worker blocks in AudioRecord.read, feeds the reused CwDecoder
 * serially, drains native UTF-8 text, and owns native finish/delete. The UI only
 * polls main-looper state and text; it never calls JNI from an audio callback.
 * Cancellation comes from a separate control executor calling AudioRecord.stop.
 */
public final class MainActivity extends Activity {
    private static final int REQUEST_RECORD_AUDIO = 41;
    private static final AtomicBoolean CAPTURE_SLOT = new AtomicBoolean(false);
    private static final int SAMPLE_RATE = 22050;
    private static final int READ_SAMPLES = 2048;
    // ~64 KiB of ASCII; old complete characters are dropped first.
    private static final int MAX_DISPLAY_CHARS = 32768;
    private static final String PLACEHOLDER = "让手机靠近 CW 扬声器，然后开始接收。";
    private static final String READY_STATUS = "准备接收 · 目标音调 600 Hz";

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService control =
            Executors.newSingleThreadExecutor(namedThread("cw-control"));
    private final ExecutorService audioWorker =
            Executors.newSingleThreadExecutor(namedThread("cw-audio"));

    private final Object pendingLock = new Object();
    private final StringBuilder pendingText = new StringBuilder();
    private final StringBuilder displayText = new StringBuilder();

    private TextView statusText;
    private TextView levelText;
    private TextView formatText;
    private TextView transcriptView;
    private TextView truncationText;
    private TextView errorText;
    private ProgressBar levelBar;
    private ScrollView transcriptScroll;
    private Button actionButton;

    private volatile boolean resumed;
    private volatile boolean destroyed;
    private boolean permissionPending;
    private boolean cleanupUnknown;
    private int nextRunId;
    private volatile Run activeRun;
    private int displayDroppedChars;
    private final AtomicInteger pendingDroppedChars = new AtomicInteger();
    private long nativeTruncatedBytes;
    private int shownPeak;

    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            if (destroyed) {
                return;
            }
            pullPendingText();
            updateLevels();
            updateActionButton();
            showTruncation();
            ui.postDelayed(this, 120);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        // Target 36 enforces edge-to-edge. Keep controls outside system bars/cutouts.
        View root = findViewById(R.id.rootLayout);
        final int left = root.getPaddingLeft(), top = root.getPaddingTop();
        final int right = root.getPaddingRight(), bottom = root.getPaddingBottom();
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            int l, t, r, b;
            if (Build.VERSION.SDK_INT >= 30) {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars()
                        | WindowInsets.Type.displayCutout());
                l = bars.left; t = bars.top; r = bars.right; b = bars.bottom;
            } else {
                l = insets.getSystemWindowInsetLeft(); t = insets.getSystemWindowInsetTop();
                r = insets.getSystemWindowInsetRight(); b = insets.getSystemWindowInsetBottom();
            }
            view.setPadding(left + l, top + t, right + r, bottom + b);
            return insets;
        });
        root.requestApplyInsets();

        statusText = findViewById(R.id.statusText);
        levelText = findViewById(R.id.levelText);
        formatText = findViewById(R.id.formatText);
        transcriptView = findViewById(R.id.transcriptView);
        truncationText = findViewById(R.id.truncationText);
        errorText = findViewById(R.id.errorText);
        levelBar = findViewById(R.id.levelBar);
        transcriptScroll = findViewById(R.id.transcriptScroll);
        actionButton = findViewById(R.id.actionButton);
        Button clearButton = findViewById(R.id.clearButton);
        Button copyButton = findViewById(R.id.copyButton);

        // Custom flat backgrounds must not be tinted by the platform theme.
        actionButton.setBackgroundTintList(null);
        clearButton.setBackgroundTintList(null);
        copyButton.setBackgroundTintList(null);

        clearButton.setOnClickListener(v -> clearTranscript());
        copyButton.setOnClickListener(v -> copyTranscript());
        actionButton.setOnClickListener(v -> {
            if (activeRun != null) {
                requestStop(null);
            } else {
                beginCapture();
            }
        });

        setStatus(READY_STATUS);
        setRunningVisual(false);
        updateActionButton();
        ui.post(poll);
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        if (activeRun == null && !cleanupUnknown && !permissionPending) {
            setStatus(READY_STATUS);
            setRunningVisual(false);
        }
    }

    @Override
    protected void onPause() {
        resumed = false;
        requestStop("已暂停");
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        resumed = false;
        ui.removeCallbacks(poll);
        Run run = activeRun;
        if (run != null) {
            run.stopRequested = true;
            try {
                control.execute(() -> stopRecord(run));
            } catch (RejectedExecutionException ignored) {
                // Keep the process-wide capture slot occupied until the worker confirms release.
            }
        }
        control.shutdown();
        audioWorker.shutdown();
        super.onDestroy();
    }

    @Override
    public void onRequestPermissionsResult(
            int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_RECORD_AUDIO) {
            return;
        }
        permissionPending = false;
        boolean granted = grantResults.length == 1
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (!granted) {
            setStatus("未授予麦克风权限，无法接收");
            setError("需要 RECORD_AUDIO 权限；不会在后台自动重新请求。");
            updateActionButton();
            return;
        }
        if (!resumed || destroyed) {
            // The permission dialog can pause the activity. Never start capture
            // from this callback while the activity is not resumed.
            setStatus("权限已授予 · 返回前台后再开始");
            setRunningVisual(false);
            updateActionButton();
            return;
        }
        startPrepared();
    }

    private void beginCapture() {
        if (destroyed || !resumed || activeRun != null || cleanupUnknown
                || permissionPending) {
            return;
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            permissionPending = true;
            setStatus("请求麦克风权限…");
            setError(null);
            updateActionButton();
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO},
                    REQUEST_RECORD_AUDIO);
            return;
        }
        startPrepared();
    }

    private void startPrepared() {
        if (destroyed || !resumed || activeRun != null || cleanupUnknown) {
            return;
        }
        if (!CAPTURE_SLOT.compareAndSet(false, true)) {
            setStatus("上一采集尚未释放");
            setError("请等待原采集结束；若持续无法结束，请从系统强行停止应用再重开。");
            return;
        }
        Run run = new Run(++nextRunId);
        activeRun = run;
        run.running = false;
        setError(null);
        setStatus("正在启动采集…");
        setRunningVisual(false);
        transcriptView.setTextColor(getColor(R.color.cw_cream));
        updateActionButton();

        try {
            control.execute(() -> prepareRun(run));
        } catch (RejectedExecutionException error) {
            activeRun = null;
            CAPTURE_SLOT.set(false);
            setStatus("启动失败：控制线程不可用");
            setError(describe(error));
            updateActionButton();
        }
    }

    private void prepareRun(Run run) {
        AudioRecord record = null;
        boolean releaseOk = true;
        String releaseError = null;
        try {
            int source;
            String sourceName;
            String fallbackReason = null;
            AudioManager manager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            if (manager != null && "true".equals(manager.getProperty(
                    AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED))) {
                source = MediaRecorder.AudioSource.UNPROCESSED;
                sourceName = "UNPROCESSED";
            } else {
                source = MediaRecorder.AudioSource.MIC;
                sourceName = "MIC";
                fallbackReason = "设备不支持 UNPROCESSED";
            }

            try {
                record = buildRecord(source);
            } catch (RuntimeException error) {
                if (source != MediaRecorder.AudioSource.UNPROCESSED) {
                    throw error;
                }
                // Explicit, visible MIC fallback; no sample-rate or format fallback.
                fallbackReason = "UNPROCESSED 构建失败：" + describe(error);
                source = MediaRecorder.AudioSource.MIC;
                sourceName = "MIC";
                record = buildRecord(source);
            }

            run.record = record;
            if (record.getState() != AudioRecord.STATE_INITIALIZED) {
                throw new IOException("AudioRecord 未初始化（state="
                        + record.getState() + "）");
            }
            verifyFormat(record, source);

            String label = sourceName + " · " + SAMPLE_RATE
                    + " Hz · 单声道 · S16LE";
            if (fallbackReason != null) {
                label = sourceName + " 回退（" + fallbackReason + "） · "
                        + SAMPLE_RATE + " Hz · 单声道 · S16LE";
            }
            run.formatLabel = label;

            if (!isActive(run)) {
                run.record = null;
                boolean released = releaseRecord(run, record);
                if (released) CAPTURE_SLOT.set(false);
                ui.post(() -> finishWithoutWorker(run, "已取消启动", released,
                        released ? null : "AudioRecord.release 异常"));
                return;
            }

            final AudioRecord workerRecord = record;
            audioWorker.execute(() -> runWorker(run, workerRecord));
        } catch (Throwable error) {
            run.record = null;
            if (record != null) {
                releaseOk = releaseRecord(run, record);
                if (!releaseOk) {
                    releaseError = "AudioRecord.release 异常";
                }
            }
            if (releaseOk) CAPTURE_SLOT.set(false);
            final boolean ok = releaseOk;
            final String release = releaseError;
            final String message = describe(error);
            ui.post(() -> finishWithoutWorker(run, "启动失败：" + message, ok, release));
        }
    }

    private AudioRecord buildRecord(int source) {
        // Permission can be revoked between the UI gate and worker construction.
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            throw new SecurityException("麦克风权限已撤销");
        }
        int minBuffer = AudioRecord.getMinBufferSize(
                SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (minBuffer <= 0) {
            throw new IllegalStateException("getMinBufferSize=" + minBuffer);
        }
        int bufferBytes = Math.max(minBuffer * 2, READ_SAMPLES * 2 * 4);
        AudioFormat format = new AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(SAMPLE_RATE)
                .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                .build();
        return new AudioRecord.Builder()
                .setAudioSource(source)
                .setAudioFormat(format)
                .setBufferSizeInBytes(bufferBytes)
                .build();
    }

    private static void verifyFormat(AudioRecord record, int requestedSource) {
        if (record.getAudioSource() != requestedSource) {
            throw new IllegalStateException("AudioRecord 源回读="
                    + record.getAudioSource() + "，请求=" + requestedSource);
        }
        if (record.getSampleRate() != SAMPLE_RATE) {
            throw new IllegalStateException("AudioRecord 采样率回读="
                    + record.getSampleRate() + "，请求=" + SAMPLE_RATE);
        }
        if (record.getChannelCount() != 1) {
            throw new IllegalStateException("AudioRecord 声道回读="
                    + record.getChannelCount() + "，请求=1");
        }
        if (record.getAudioFormat() != AudioFormat.ENCODING_PCM_16BIT) {
            throw new IllegalStateException("AudioRecord 编码回读="
                    + record.getAudioFormat() + "，请求=PCM16");
        }
    }

    private void runWorker(Run run, AudioRecord record) {
        long handle = 0;
        String failure = null;
        String workerStopError = null;
        boolean releaseOk = true;
        String releaseFailure = null;

        try {
            handle = CwNative.nativeCreate();
            if (handle == 0) {
                throw new IOException("nativeCreate 返回 0");
            }
            run.decoder = handle;
            String initError = utf8(CwNative.nativeError(handle));
            if (!initError.isEmpty()) {
                throw new IOException("解码器初始化失败：" + initError);
            }
            if (!isActive(run)) {
                throw new CancelledStart();
            }

            synchronized (run.recordLock) {
                if (!isActive(run)) throw new CancelledStart();
                record.startRecording();
                run.recording = true;
            }
            if (record.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
                throw new IOException("startRecording 后状态="
                        + record.getRecordingState());
            }
            if (!isActive(run)) {
                throw new CancelledStart();
            }

            run.running = true;
            ui.post(() -> onStarted(run));

            short[] pcm = new short[READ_SAMPLES];
            int zeroReads = 0;
            while (isActive(run)) {
                int samples;
                try {
                    samples = record.read(pcm, 0, pcm.length, AudioRecord.READ_BLOCKING);
                } catch (RuntimeException error) {
                    if (!isActive(run)) {
                        break;
                    }
                    throw new IOException("AudioRecord.read 异常：" + describe(error), error);
                }
                if (samples < 0) {
                    if (!isActive(run)) {
                        break;
                    }
                    throw new IOException("AudioRecord.read 错误码 " + samples);
                }
                if (samples == 0) {
                    // Do not spin if a driver returns zero without blocking.
                    zeroReads++;
                    if (zeroReads > 50) {
                        throw new IOException("AudioRecord.read 连续返回 0");
                    }
                    continue;
                }
                zeroReads = 0;
                if (!isActive(run)) {
                    break;
                }

                updateLevel(run, pcm, samples);
                if (!CwNative.nativeFeed(handle, pcm, samples)) {
                    throw new IOException("nativeFeed 返回 false");
                }
                drainNative(run, handle);
            }
        } catch (CancelledStart cancelled) {
            failure = null;
        } catch (Throwable error) {
            failure = describe(error);
        } finally {
            // Capture must be stopped before the 0.5 s native tail is fed.
            synchronized (run.recordLock) {
              if (run.recording) {
                try {
                    record.stop();
                } catch (RuntimeException error) {
                    workerStopError = "AudioRecord.stop：" + describe(error);
                }
                run.recording = false;
              }
            }

            if (handle != 0) {
                try {
                    if (!CwNative.nativeFinish(handle, true)) {
                        if (failure == null) {
                            failure = "nativeFinish 返回 false";
                        }
                    }
                    drainNative(run, handle);
                } catch (Throwable error) {
                    if (failure == null) {
                        failure = "nativeFinish 异常：" + describe(error);
                    }
                } finally {
                    try {
                        CwNative.nativeDestroy(handle);
                    } catch (Throwable error) {
                        if (failure == null) {
                            failure = "nativeDestroy 异常：" + describe(error);
                        }
                    }
                    run.decoder = 0;
                }
            }

            try {
                synchronized (run.recordLock) {
                    record.release();
                    run.record = null;
                }
            } catch (RuntimeException error) {
                releaseOk = false;
                releaseFailure = "AudioRecord.release：" + describe(error);
            }
            run.record = null;
            run.running = false;
            if (releaseOk) CAPTURE_SLOT.set(false);

            final String finalFailure = failure;
            final String finalStopError = workerStopError;
            final boolean finalReleaseOk = releaseOk;
            final String finalReleaseFailure = releaseFailure;
            ui.post(() -> finishRun(run, finalFailure, finalStopError,
                    finalReleaseOk, finalReleaseFailure));
        }
    }

    private void drainNative(Run run, long handle) {
        byte[] bytes = CwNative.nativeDrain(handle);
        if (bytes != null && bytes.length > 0) {
            appendPending(new String(bytes, StandardCharsets.UTF_8));
        }
        long truncated = CwNative.nativeTruncatedBytes(handle);
        if (truncated > 0) {
            run.nativeTruncatedBytes = truncated;
        }
    }

    private void updateLevel(Run run, short[] pcm, int count) {
        double sum = 0.0;
        int peak = 0;
        for (int i = 0; i < count; i++) {
            int value = pcm[i];
            sum += (double) value * value;
            int magnitude = Math.abs(value);
            if (magnitude > peak) {
                peak = magnitude;
            }
        }
        double rms = Math.sqrt(sum / count) / 32768.0;
        int rmsPermille = (int) Math.round(Math.min(1.0, rms) * 1000.0);
        int peakPermille = (int) Math.round(Math.min(1.0, peak / 32768.0) * 1000.0);
        run.rmsPermille.set(rmsPermille);
        while (true) {
            int old = run.peakPermille.get();
            if (peakPermille <= old
                    || run.peakPermille.compareAndSet(old, peakPermille)) {
                break;
            }
        }
    }

    private void onStarted(Run run) {
        if (destroyed || activeRun != run || run.stopRequested || !resumed) {
            return;
        }
        setStatus("正在接收 · 目标音调 600 Hz");
        setRunningVisual(true);
        formatText.setText(run.formatLabel);
        updateActionButton();
    }

    private void finishWithoutWorker(
            Run run, String message, boolean releaseOk, String releaseFailure) {
        if (destroyed || activeRun != run) {
            return;
        }
        activeRun = null;
        run.running = false;
        setRunningVisual(false);
        updateActionButton();
        if (!releaseOk) {
            cleanupUnknown = true;
            setStatus("启动失败且采集释放失败，需重启应用");
            setError(message + "；" + releaseFailure
                    + "。采集状态未知，已禁止再次开始。");
            updateActionButton();
        } else {
            setStatus(message);
            setError(run.stopRequested ? null : message);
        }
    }

    private void finishRun(
            Run run,
            String failure,
            String stopError,
            boolean releaseOk,
            String releaseFailure) {
        if (destroyed || activeRun != run) {
            return;
        }
        activeRun = null;
        run.running = false;
        run.rmsPermille.set(0);
        run.peakPermille.set(0);
        if (run.nativeTruncatedBytes > nativeTruncatedBytes) {
            nativeTruncatedBytes = run.nativeTruncatedBytes;
        }
        pullPendingText();
        updateLevels();
        setRunningVisual(false);

        String context = run.stopContext;
        boolean paused = context != null && context.startsWith("已暂停");

        if (!releaseOk) {
            cleanupUnknown = true;
            setStatus("采集释放失败 · 状态未知，需重启应用");
            setError("AudioRecord.release 失败：" + releaseFailure
                    + "；不能声称已停止。请重启应用后再接收。");
            updateActionButton();
            return;
        }

        if (failure != null) {
            setStatus(paused ? "已暂停 · 接收中断" : "接收中断 · 已停止");
            setError("接收中断：" + failure);
        } else if (stopError != null) {
            // release succeeded, so capture resources are freed, but do not claim
            // that the stop() call itself succeeded.
            setStatus(paused ? "已暂停 · 采集已释放" : "已停止 · 采集已释放");
            setError("stop 调用异常（资源已释放）：" + stopError);
        } else if (paused) {
            setStatus("已暂停 · 已停止");
            setError(null);
        } else {
            setStatus("已停止 · 可再次开始");
            setError(null);
        }
        updateActionButton();
    }

    private void requestStop(String context) {
        Run run = activeRun;
        if (run == null) {
            if (context != null) {
                setStatus(context + " · 已停止");
                setRunningVisual(false);
            }
            return;
        }
        run.stopContext = context;
        run.stopRequested = true;
        ui.postDelayed(() -> {
            if (!destroyed && activeRun == run) {
                setStatus("停止尚未完成 · 采集状态未知");
                setError("系统音频尚未返回，不能确认释放。请等待；若持续如此，请从系统强行停止应用。");
            }
        }, 3000);
        setStatus(context == null ? "正在停止…" : context + " · 正在停止…");
        updateActionButton();

        try {
            control.execute(() -> stopRecord(run));
        } catch (RejectedExecutionException error) {
            setError("停止请求无法提交：" + describe(error) + "；采集仍在等待释放。");
        }
    }

    private void stopRecord(Run run) {
        // Serializes stop with start/release, never with blocking read or the UI.
        synchronized (run.recordLock) {
            AudioRecord record = run.record;
            if (record == null || !run.recording) return;
            try {
                record.stop();
                run.recording = false;
            } catch (RuntimeException error) {
                final String message = describe(error);
                ui.post(() -> {
                    if (!destroyed && activeRun == run) {
                        setError("停止调用异常：" + message + "；正在等待采集线程释放。");
                    }
                });
            }
        }
    }

    private boolean isActive(Run run) {
        return !destroyed && activeRun == run && !run.stopRequested;
    }

    private boolean releaseRecord(Run run, AudioRecord record) {
        try {
            synchronized (run.recordLock) { record.release(); }
            return true;
        } catch (RuntimeException error) {
            return false;
        }
    }

    private void pullPendingText() {
        displayDroppedChars += pendingDroppedChars.getAndSet(0);
        String chunk;
        synchronized (pendingLock) {
            if (pendingText.length() == 0) {
                return;
            }
            chunk = pendingText.toString();
            pendingText.setLength(0);
        }
        displayText.append(chunk);
        if (displayText.length() > MAX_DISPLAY_CHARS) {
            int cut = displayText.length() - MAX_DISPLAY_CHARS;
            if (cut > 0 && cut < displayText.length()
                    && Character.isLowSurrogate(displayText.charAt(cut))) {
                cut++;
            }
            displayText.delete(0, cut);
            displayDroppedChars += cut;
        }
        showTranscript();
    }

    private void appendPending(String text) {
        if (text.isEmpty()) {
            return;
        }
        synchronized (pendingLock) {
            pendingText.append(text);
            // The native side is already capped; this is a second bound against a
            // stalled UI thread. Drop oldest complete UTF-16 units first.
            int overflow = pendingText.length() - MAX_DISPLAY_CHARS;
            if (overflow > 0) {
                if (Character.isLowSurrogate(pendingText.charAt(overflow))) {
                    overflow++;
                }
                pendingText.delete(0, overflow);
                pendingDroppedChars.addAndGet(overflow);
            }
        }
    }

    private void showTranscript() {
        if (displayText.length() == 0) {
            transcriptView.setText(PLACEHOLDER);
            transcriptView.setTextColor(getColor(R.color.cw_faint));
            return;
        }
        transcriptView.setText(displayText.toString());
        transcriptView.setTextColor(getColor(R.color.cw_cream));
        transcriptScroll.post(() -> transcriptScroll.fullScroll(View.FOCUS_DOWN));
    }

    private void updateLevels() {
        Run run = activeRun;
        int level = 0;
        int peak = 0;
        if (run != null) {
            level = Math.min(100, run.rmsPermille.get() / 10);
            int currentPeak = Math.min(100, run.peakPermille.getAndSet(0) / 10);
            shownPeak = Math.max(currentPeak, shownPeak * 85 / 100);
            peak = shownPeak;
        } else {
            shownPeak = shownPeak * 85 / 100;
            peak = shownPeak;
        }
        levelBar.setProgress(level);
        levelText.setText(String.format(Locale.US, "%d%%  /  峰值 %d%%", level, peak));
    }

    private void setRunningVisual(boolean running) {
        statusText.setTextColor(getColor(running ? R.color.cw_teal : R.color.cw_muted));
    }

    private void updateActionButton() {
        if (cleanupUnknown) {
            actionButton.setText("需重启应用");
            actionButton.setBackgroundResource(R.drawable.bg_action_stop);
            actionButton.setEnabled(false);
            return;
        }
        if (permissionPending) {
            actionButton.setText("请求权限…");
            actionButton.setBackgroundResource(R.drawable.bg_action_start);
            actionButton.setEnabled(false);
            return;
        }
        boolean active = activeRun != null;
        actionButton.setText(active ? "停止接收" : "开始接收");
        actionButton.setBackgroundResource(
                active ? R.drawable.bg_action_stop : R.drawable.bg_action_start);
        actionButton.setEnabled(true);
    }

    private void showTruncation() {
        if (displayDroppedChars == 0 && nativeTruncatedBytes == 0) {
            truncationText.setVisibility(View.GONE);
            return;
        }
        StringBuilder message = new StringBuilder("显示有界：");
        if (displayDroppedChars > 0) {
            message.append("已丢弃旧显示 ").append(displayDroppedChars).append(" 字符");
        }
        if (nativeTruncatedBytes > 0) {
            if (displayDroppedChars > 0) {
                message.append(" · ");
            }
            message.append("解码缓冲截断 ").append(nativeTruncatedBytes).append(" 字节");
        }
        truncationText.setText(message.toString());
        truncationText.setVisibility(View.VISIBLE);
    }

    private void clearTranscript() {
        displayText.setLength(0);
        displayDroppedChars = 0;
        pendingDroppedChars.set(0);
        nativeTruncatedBytes = 0;
        synchronized (pendingLock) {
            pendingText.setLength(0);
        }
        Run run = activeRun;
        if (run != null) {
            long handle = run.decoder;
            if (handle != 0) {
                try {
                    // Clears pending native text only; decoder timing/filter state
                    // is deliberately not reset.
                    CwNative.nativeClear(handle);
                } catch (Throwable ignored) {
                    // A concurrent worker finish/destroy is reflected by the handle
                    // registry; clearing display still succeeds.
                }
            }
            run.nativeTruncatedBytes = 0;
        }
        showTranscript();
        showTruncation();
    }

    private void copyTranscript() {
        String text = displayText.toString();
        if (text.isEmpty()) {
            Toast.makeText(this, "没有可复制的译文", Toast.LENGTH_SHORT).show();
            return;
        }
        ClipboardManager clipboard =
                (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard == null) {
            Toast.makeText(this, "系统剪贴板不可用", Toast.LENGTH_SHORT).show();
            return;
        }
        clipboard.setPrimaryClip(ClipData.newPlainText("CW transcript", text));
        Toast.makeText(this, "已复制 " + text.length() + " 字符", Toast.LENGTH_SHORT).show();
    }

    private void setStatus(String message) {
        statusText.setText(message);
    }

    private void setError(String message) {
        if (message == null || message.isEmpty()) {
            errorText.setText("");
            errorText.setVisibility(View.GONE);
        } else {
            errorText.setText(message);
            errorText.setVisibility(View.VISIBLE);
        }
    }

    private static String describe(Throwable error) {
        if (error == null) {
            return "未知错误";
        }
        String message = error.getMessage();
        String type = error.getClass().getSimpleName();
        return message == null || message.isEmpty() ? type : type + "：" + message;
    }

    private static String utf8(byte[] bytes) {
        return bytes == null ? "" : new String(bytes, StandardCharsets.UTF_8);
    }

    private static ThreadFactory namedThread(String name) {
        return runnable -> {
            Thread thread = new Thread(runnable, name);
            thread.setDaemon(false);
            return thread;
        };
    }

    private static final class CancelledStart extends Exception {
    }

    private static final class Run {
        final int id;
        final Object recordLock = new Object();
        final AtomicInteger rmsPermille = new AtomicInteger();
        final AtomicInteger peakPermille = new AtomicInteger();
        volatile AudioRecord record;
        volatile long decoder;
        volatile boolean recording;
        volatile boolean running;
        volatile boolean stopRequested;
        volatile String stopContext;
        volatile String formatLabel = "";
        volatile long nativeTruncatedBytes;

        Run(int id) {
            this.id = id;
        }
    }
}
