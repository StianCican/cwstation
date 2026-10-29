package org.cwstation.androidcw;
import java.nio.file.*;
import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
public final class JniSmoke {
  static void check(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }
  public static void main(String[] args) throws Exception {
    byte[] bytes = Files.readAllBytes(Path.of(args[0]));
    short[] pcm = new short[bytes.length/2];
    ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(pcm);
    long first = CwNative.nativeCreate();
    check(first > 0 && CwNative.nativeError(first).length == 0, "create");
    long second = CwNative.nativeCreate();
    check(second > 0 && CwNative.nativeError(second).length > 0, "second instance rejects");
    check(CwNative.nativeDestroy(second), "destroy invalid second");
    check(!CwNative.nativeFeed(first, null, 1), "null rejects");
    check(!CwNative.nativeFeed(first, new short[1], 2), "count rejects");
    check(!CwNative.nativeFeed(first, new short[1], -1), "negative rejects");
    StringBuilder output = new StringBuilder();
    for (int i=0; i<pcm.length; i+=997) {
      short[] chunk=Arrays.copyOfRange(pcm,i,Math.min(i+997,pcm.length));
      check(CwNative.nativeFeed(first,chunk,chunk.length), "feed");
      output.append(new String(CwNative.nativeDrain(first),StandardCharsets.UTF_8));
    }
    check(CwNative.nativeFinish(first,true), "finish");
    check(CwNative.nativeFinish(first,true), "finish idempotent");
    output.append(new String(CwNative.nativeDrain(first),StandardCharsets.UTF_8));
    check(!CwNative.nativeFeed(first,new short[1],1), "feed after EOF rejects");
    CwNative.nativeClear(first);
    check(CwNative.nativeDrain(first).length==0, "clear pending");
    check(CwNative.nativeDestroy(first), "destroy");
    check(!CwNative.nativeDestroy(first), "double destroy rejects");
    check(!CwNative.nativeFeed(first,new short[1],1), "stale feed rejects");
    CwNative.nativeClear(first);
    check(CwNative.nativeDrain(first).length==0, "stale drain safe");
    long third=CwNative.nativeCreate();
    check(third>0 && CwNative.nativeError(third).length==0,"recreate");
    check(CwNative.nativeDestroy(third),"recreate destroy");
    Files.writeString(Path.of(args[1]),output.toString());
    System.out.println("PASS: actual JNI create/feed/drain/finish/clear/stale handle/instance boundary");
  }
}
