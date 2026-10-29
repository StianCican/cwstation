package org.cwstation.androidcw;

/**
 * Thin JNI boundary. Native code owns the reused CwDecoder; Java only holds an
 * opaque id. UTF-8 text crosses the boundary as byte[], never as a C string.
 */
final class CwNative {
    static {
        System.loadLibrary("cwdecoder_jni");
    }

    private CwNative() {
    }

    /** Returns a positive opaque handle, or 0 on native allocation failure. */
    static native long nativeCreate();

    /** UTF-8 error text for an invalid decoder, empty when valid. */
    static native byte[] nativeError(long handle);

    /** Feeds 22050 Hz mono S16LE samples; call only from the capture worker. */
    static native boolean nativeFeed(long handle, short[] samples, int sampleCount);

    /** Drains pending UTF-8 text; safe while the capture worker feeds. */
    static native byte[] nativeDrain(long handle);

    /** Feeds the 0.5 s silence tail and deinitializes; call only from the worker. */
    static native boolean nativeFinish(long handle, boolean synthesizeTail);

    static native long nativeTruncatedBytes(long handle);

    /** Clears only pending text/truncation, not decoder timing or filters. */
    static native void nativeClear(long handle);

    /** Removes the handle exactly once; the decoder is deleted after final use. */
    static native boolean nativeDestroy(long handle);
}
