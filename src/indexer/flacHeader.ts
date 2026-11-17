export interface FlacStreamInfo {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  totalSamples: number;
  durationSec: number;
}

/** Parse the STREAMINFO block from the first bytes of a FLAC file ("fLaC" + metadata block header + 34 bytes). */
export function parseFlacStreamInfo(b: Buffer): FlacStreamInfo | null {
  if (b.length < 42 || b.toString('latin1', 0, 4) !== 'fLaC') return null;
  if ((b[4] & 0x7f) !== 0) return null; // first block must be STREAMINFO (type 0)
  const o = 18; // 4 magic + 4 block header + 2+2 block sizes + 3+3 frame sizes
  const sampleRate = (b[o] << 12) | (b[o + 1] << 4) | (b[o + 2] >> 4);
  const channels = ((b[o + 2] >> 1) & 0x7) + 1;
  const bitDepth = (((b[o + 2] & 1) << 4) | (b[o + 3] >> 4)) + 1;
  const totalSamples = (b[o + 3] & 0x0f) * 2 ** 32 + b.readUInt32BE(o + 4);
  if (!sampleRate) return null;
  return { sampleRate, channels, bitDepth, totalSamples, durationSec: totalSamples / sampleRate };
}

/** Range-fetch the head of a FLAC at `url` and read its STREAMINFO. Best-effort: returns null on any failure. */
export async function probeFlac(url: string, timeoutMs = 6000): Promise<FlacStreamInfo | null> {
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-511' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok && res.status !== 206) return null;
    const head = Buffer.from(await res.arrayBuffer()).subarray(0, 512);
    return parseFlacStreamInfo(head);
  } catch {
    return null;
  }
}
