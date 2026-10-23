import { GIFEncoder, quantize, applyPalette } from './vendor/gifenc.esm.js';

// 이전에 보인 색이 새로 고른 색보다 이만큼(제곱 거리) 이내로만 나쁘면 '안 바뀜'으로 친다.
// 동영상 압축 잡음 때문에 가만히 있는 화면도 픽셀값이 조금씩 흔들리는데, 그걸 변화로 세지 않으려는 것이다.
const UNCHANGED_TOLERANCE = 100;

let job = null;

self.onmessage = ({ data }) => {
  try {
    if (data.type === 'start') {
      start(data);
    } else if (data.type === 'frame') {
      const pixels = new Uint8ClampedArray(data.pixels);
      if (job.kind === 'screen') writeScreenFrame(pixels, data.delay);
      else writeVideoFrame(pixels, data.delay);
      self.postMessage({ type: 'frame-done', index: data.index });
    } else if (data.type === 'finish') {
      job.gif.finish();
      const bytes = job.gif.bytes();
      self.postMessage({ type: 'done', bytes: bytes.buffer }, [bytes.buffer]);
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message ?? String(error) });
  }
};

function start({ width, height, kind, colors, loop, samples }) {
  job = {
    gif: GIFEncoder(),
    width,
    height,
    kind,
    colors,
    repeat: loop ? 0 : -1,
    isFirst: true,
  };

  if (kind === 'screen') {
    // 팔레트 마지막 한 칸은 '앞 프레임 그대로 둠'을 뜻하는 투명색으로 비워 둔다.
    const palette = quantize(new Uint8ClampedArray(samples), colors - 1);
    job.palette = palette;
    job.transparentIndex = palette.length;
    job.tablePalette = [...palette, [0, 0, 0]];
    job.shown = new Uint8Array(width * height);
  }
}

// 화면 녹화: 팔레트 하나를 같이 쓰고, 앞 프레임과 같은 픽셀은 투명으로 비워 바뀐 곳만 저장한다.
function writeScreenFrame(pixels, delay) {
  const { gif, width, height, palette, transparentIndex, shown } = job;
  const index = applyPalette(pixels, palette);

  if (job.isFirst) {
    job.isFirst = false;
    shown.set(index);
    gif.writeFrame(index, width, height, { palette: job.tablePalette, delay, repeat: job.repeat, dispose: 1 });
    return;
  }

  for (let p = 0, o = 0; p < index.length; p++, o += 4) {
    const next = index[p];
    const prev = shown[p];
    if (next === prev) {
      index[p] = transparentIndex;
      continue;
    }
    const r = pixels[o];
    const g = pixels[o + 1];
    const b = pixels[o + 2];
    const before = palette[prev];
    const after = palette[next];
    const distBefore = (r - before[0]) ** 2 + (g - before[1]) ** 2 + (b - before[2]) ** 2;
    const distAfter = (r - after[0]) ** 2 + (g - after[1]) ** 2 + (b - after[2]) ** 2;
    if (distBefore <= distAfter + UNCHANGED_TOLERANCE) {
      index[p] = transparentIndex;
    } else {
      shown[p] = next;
    }
  }
  gif.writeFrame(index, width, height, { transparent: true, transparentIndex, delay, dispose: 1 });
}

// 실사 영상: 프레임마다 팔레트를 새로 만든다. 첫 프레임 팔레트는 전역, 나머지는 프레임별 팔레트로 들어간다.
function writeVideoFrame(pixels, delay) {
  const { gif, width, height, colors } = job;
  const palette = quantize(pixels, colors);
  const index = applyPalette(pixels, palette);
  gif.writeFrame(index, width, height, { palette, delay, repeat: job.repeat });
}
