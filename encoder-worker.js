import { GIFEncoder } from './vendor/gifenc.esm.js';
import { buildPalette } from './palette.js';

// 원본 색이 마지막으로 그린 때보다 이만큼(제곱 거리) 이내로만 달라졌으면 '안 바뀜'으로 보고 다시 그리지 않는다.
// 동영상 압축 잡음 때문에 가만히 있는 화면도 픽셀값이 조금씩 흔들리는데, 그걸 변화로 세지 않으려는 것이다.
const PIXEL_TOLERANCE = 75;
// 둘레 5×5 평균으로 본 변화는 훨씬 작아도 바뀐 것으로 친다. 잡음은 평균을 내면 사라지지만,
// 연기가 천천히 옅어지는 것처럼 한 덩어리가 같이 바뀌는 건 평균에도 그대로 남는다.
// 이걸 놓치면 덜 바뀐 조각이 옛 색으로 남아 얼룩(띠)처럼 보인다.
const AREA_TOLERANCE = 6;
const AREA_RADIUS = 2;

let job = null;

self.onmessage = ({ data }) => {
  try {
    if (data.type === 'start') {
      start(data);
    } else if (data.type === 'frame') {
      writeFrame(new Uint8ClampedArray(data.pixels), data.delay);
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

// 팔레트 마지막 한 칸은 늘 '앞 프레임 그대로 둠'을 뜻하는 투명색 자리로 비워 둔다.
// UI 녹화는 구간 전체에서 뽑은 샘플로 팔레트를 한 번 만들어 모든 프레임이 같이 쓰고,
// 게임·실사는 프레임마다 그 프레임에서 바뀐 픽셀만 보고 팔레트를 새로 만든다.
function start({ width, height, kind, colors, loop, dither, samples }) {
  const pixelCount = width * height;
  job = {
    gif: GIFEncoder(),
    width,
    height,
    colors,
    dither,
    repeat: loop ? 0 : -1,
    isFirst: true,
    sharedPalette: kind === 'screen' ? buildPalette(new Uint8ClampedArray(samples), colors - 1) : null,
    firstTransparentIndex: 0,
    changed: new Uint8Array(pixelCount),
    shownSource: new Uint8Array(pixelCount * 3), // 지금 보이는 색을 고를 때의 원본 색
    drift: new Float32Array(pixelCount * 3),
    driftRows: new Float32Array(pixelCount * 3),
    // 오차 확산용 두 줄. 양 끝에서 한 칸씩 넘쳐도 되게 width + 2 칸을 둔다.
    errorRows: dither ? [new Float32Array((width + 2) * 3), new Float32Array((width + 2) * 3)] : null,
    matchCache: new Int16Array(1 << 18),
    cachedPalette: null,
  };
}

// 첫 프레임은 전부 그리고, 그다음부터는 바뀐 픽셀만 그린다. 나머지는 투명으로 비워(dispose 1) 앞 프레임을 그대로 보여 준다.
function writeFrame(pixels, delay) {
  const { gif, width, height, isFirst } = job;
  const changedCount = isFirst ? width * height : markChanged(pixels);

  if (changedCount === 0) {
    const index = new Uint8Array(width * height).fill(job.firstTransparentIndex);
    gif.writeFrame(index, width, height, { transparent: true, transparentIndex: job.firstTransparentIndex, delay, dispose: 1 });
    return;
  }

  const palette = job.sharedPalette ?? buildPalette(pixels, job.colors - 1, isFirst ? null : job.changed);
  const transparentIndex = palette.length;
  const table = [...palette, [0, 0, 0]];
  const index = mapPixels(pixels, palette, isFirst, transparentIndex);

  if (isFirst) {
    job.firstTransparentIndex = transparentIndex;
    gif.writeFrame(index, width, height, { palette: table, delay, repeat: job.repeat, dispose: 1 });
  } else {
    // 공용 팔레트면 첫 프레임에 넣은 표를 그대로 쓰고, 아니면 이 프레임만의 표를 붙인다.
    const localTable = job.sharedPalette ? undefined : table;
    gif.writeFrame(index, width, height, { palette: localTable, transparent: true, transparentIndex, delay, dispose: 1 });
  }
  job.isFirst = false;
}

function markChanged(pixels) {
  const { width, height, changed, shownSource, drift, driftRows } = job;
  for (let p = 0, o = 0, s = 0; p < changed.length; p++, o += 4, s += 3) {
    const dr = pixels[o] - shownSource[s];
    const dg = pixels[o + 1] - shownSource[s + 1];
    const db = pixels[o + 2] - shownSource[s + 2];
    drift[s] = dr;
    drift[s + 1] = dg;
    drift[s + 2] = db;
    changed[p] = dr * dr + dg * dg + db * db > PIXEL_TOLERANCE ? 1 : 0;
  }
  // 가로로 한 번, 세로로 한 번 평균을 내서 둘레 5×5 평균을 만든다.
  boxAverage(drift, driftRows, width, height, 1, width);
  boxAverage(driftRows, drift, height, width, width, 1);

  let count = 0;
  for (let p = 0, s = 0; p < changed.length; p++, s += 3) {
    if (changed[p] === 0 && drift[s] * drift[s] + drift[s + 1] * drift[s + 1] + drift[s + 2] * drift[s + 2] > AREA_TOLERANCE) {
      changed[p] = 1;
    }
    count += changed[p];
  }
  return count;
}

// 한 줄을 따라 앞뒤 AREA_RADIUS 칸의 평균을 낸다(창을 한 칸씩 밀며 더하고 뺀다). 가장자리에서는 있는 칸만 센다.
// step 은 그 줄을 따라 한 칸 갈 때의 픽셀 간격, lineStep 은 다음 줄로 넘어갈 때의 픽셀 간격이다.
function boxAverage(from, to, length, lines, step, lineStep) {
  for (let line = 0; line < lines; line++) {
    const base = line * lineStep;
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let k = 0; k < Math.min(AREA_RADIUS, length); k++) {
      const q = (base + k * step) * 3;
      r += from[q];
      g += from[q + 1];
      b += from[q + 2];
      n++;
    }
    for (let i = 0; i < length; i++) {
      const enter = i + AREA_RADIUS;
      if (enter < length) {
        const q = (base + enter * step) * 3;
        r += from[q];
        g += from[q + 1];
        b += from[q + 2];
        n++;
      }
      const leave = i - AREA_RADIUS - 1;
      if (leave >= 0) {
        const q = (base + leave * step) * 3;
        r -= from[q];
        g -= from[q + 1];
        b -= from[q + 2];
        n--;
      }
      const t = (base + i * step) * 3;
      to[t] = r / n;
      to[t + 1] = g / n;
      to[t + 2] = b / n;
    }
  }
}

// 픽셀마다 팔레트 색 번호를 고른다. 디더링을 켜면 Floyd–Steinberg 오차 확산으로 색 띠(나이테 무늬)를 잔 점으로 풀고,
// 줄마다 방향을 바꿔(serpentine) 한쪽으로 쏠리는 무늬를 줄인다.
// 다시 그리지 않는 픽셀에서는 오차를 넘기지 않는다. 그 픽셀의 원본이 조금씩 바뀐 만큼이 오차로 넘어가면
// 아래로 내려갈수록 쌓여서, 다음에 만나는 바뀐 픽셀이 엉뚱한 색이 된다.
function mapPixels(pixels, palette, drawAll, transparentIndex) {
  const { width, height, dither, changed, shownSource } = job;
  const flat = new Float32Array(palette.length * 3);
  palette.forEach((color, i) => flat.set(color, i * 3));
  if (palette !== job.cachedPalette) {
    job.matchCache.fill(-1);
    job.cachedPalette = palette;
  }

  const index = new Uint8Array(width * height);
  let current = dither ? job.errorRows[0].fill(0) : null;
  let next = dither ? job.errorRows[1].fill(0) : null;

  for (let y = 0; y < height; y++) {
    const isReversed = dither && (y & 1) === 1;
    const step = isReversed ? -1 : 1;

    for (let i = 0; i < width; i++) {
      const x = isReversed ? width - 1 - i : i;
      const p = y * width + x;
      const o = p * 4;
      const s = p * 3;
      let r = pixels[o];
      let g = pixels[o + 1];
      let b = pixels[o + 2];
      if (dither) {
        const e = (x + 1) * 3;
        r = clamp255(r + current[e]);
        g = clamp255(g + current[e + 1]);
        b = clamp255(b + current[e + 2]);
      }

      if (!drawAll && changed[p] === 0) {
        index[p] = transparentIndex;
        continue;
      }

      const chosen = nearestColor(flat, Math.round(r), Math.round(g), Math.round(b));
      const c = chosen * 3;
      index[p] = chosen;
      shownSource[s] = pixels[o];
      shownSource[s + 1] = pixels[o + 1];
      shownSource[s + 2] = pixels[o + 2];
      if (dither) spreadError(current, next, x, step, r - flat[c], g - flat[c + 1], b - flat[c + 2]);
    }

    if (dither) {
      [current, next] = [next, current];
      next.fill(0);
    }
  }
  return index;
}

// 오른쪽 7/16, 아래 왼쪽 3/16, 아래 5/16, 아래 오른쪽 1/16 (줄 방향이 반대면 좌우도 뒤집는다).
function spreadError(current, next, x, step, er, eg, eb) {
  const ahead = (x + 1 + step) * 3;
  const below = (x + 1) * 3;
  const behind = (x + 1 - step) * 3;
  current[ahead] += er * 0.4375;
  current[ahead + 1] += eg * 0.4375;
  current[ahead + 2] += eb * 0.4375;
  next[behind] += er * 0.1875;
  next[behind + 1] += eg * 0.1875;
  next[behind + 2] += eb * 0.1875;
  next[below] += er * 0.3125;
  next[below + 1] += eg * 0.3125;
  next[below + 2] += eb * 0.3125;
  next[ahead] += er * 0.0625;
  next[ahead + 1] += eg * 0.0625;
  next[ahead + 2] += eb * 0.0625;
}

// 가장 가까운 팔레트 색. 채널마다 6비트로 줄인 색을 열쇠로 결과를 기억해서 같은 계산을 되풀이하지 않는다.
function nearestColor(flat, r, g, b) {
  const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
  const cached = job.matchCache[key];
  if (cached >= 0) return cached;

  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0, j = 0; j < flat.length; i++, j += 3) {
    const dr = r - flat[j];
    const dg = g - flat[j + 1];
    const db = b - flat[j + 2];
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  job.matchCache[key] = best;
  return best;
}

function clamp255(value) {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}
