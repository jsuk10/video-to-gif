// 프레임 픽셀에서 GIF 팔레트(최대 256색)를 고른다.
// 색을 채널당 6비트 칸(64×64×64)으로 모은 뒤, 오차가 가장 큰 상자부터 둘로 나누는 median cut 으로 색을 정하고,
// k-means 로 한 번 다듬는다. 칸 안의 색은 평균을 내서 쓰므로 팔레트 색 자체는 8비트 정밀도를 그대로 가진다.

const BITS = 6;
const SHIFT = 8 - BITS;
const SIDE = 1 << BITS;

// 프레임마다 새로 만들지 않도록 히스토그램 버퍼는 한 번만 잡고, 쓴 칸만 되돌린다.
const counts = new Uint32Array(SIDE ** 3);
const sums = new Float64Array(SIDE ** 3 * 3);
const touched = new Int32Array(SIDE ** 3);

// include 를 주면 그 값이 1인 픽셀만 센다(바뀐 픽셀만으로 팔레트를 만들 때).
export function buildPalette(pixels, maxColors, include = null) {
  const bins = collectBins(pixels, include);
  if (bins.count <= maxColors) return binsAsPalette(bins);

  const centers = medianCut(bins, maxColors);
  refine(bins, centers);
  return centersAsPalette(centers);
}

function collectBins(pixels, include) {
  let used = 0;
  for (let p = 0, o = 0; o < pixels.length; p++, o += 4) {
    if (include && include[p] === 0) continue;
    const r = pixels[o];
    const g = pixels[o + 1];
    const b = pixels[o + 2];
    const key = ((r >> SHIFT) << (BITS * 2)) | ((g >> SHIFT) << BITS) | (b >> SHIFT);
    if (counts[key] === 0) touched[used++] = key;
    counts[key]++;
    sums[key * 3] += r;
    sums[key * 3 + 1] += g;
    sums[key * 3 + 2] += b;
  }

  const weight = new Float64Array(used);
  const color = new Float64Array(used * 3);
  const cell = new Uint8Array(used * 3); // 칸 좌표. 상자를 자를 때 정렬 열쇠로 쓴다.
  for (let i = 0; i < used; i++) {
    const key = touched[i];
    const w = counts[key];
    weight[i] = w;
    color[i * 3] = sums[key * 3] / w;
    color[i * 3 + 1] = sums[key * 3 + 1] / w;
    color[i * 3 + 2] = sums[key * 3 + 2] / w;
    cell[i * 3] = key >> (BITS * 2);
    cell[i * 3 + 1] = (key >> BITS) & (SIDE - 1);
    cell[i * 3 + 2] = key & (SIDE - 1);
    counts[key] = 0;
    sums[key * 3] = 0;
    sums[key * 3 + 1] = 0;
    sums[key * 3 + 2] = 0;
  }
  return { count: used, weight, color, cell };
}

// 상자 = order[start, end) 구간. 매번 제곱 오차 합이 가장 큰 상자를 골라, 분산이 가장 큰 축을 따라
// 두 쪽 오차 합이 가장 작아지는 자리에서 자른다.
function medianCut(bins, maxColors) {
  const order = new Int32Array(bins.count);
  for (let i = 0; i < bins.count; i++) order[i] = i;
  const scratch = new Int32Array(bins.count);
  const boxes = [measureBox(bins, order, 0, bins.count)];

  while (boxes.length < maxColors) {
    let target = 0;
    for (let i = 1; i < boxes.length; i++) {
      if (boxes[i].error > boxes[target].error) target = i;
    }
    const box = boxes[target];
    if (box.error <= 0) break;

    sortByCell(bins, order, scratch, box.start, box.end, box.axis);
    const cut = bestCut(bins, order, box.start, box.end);
    boxes[target] = measureBox(bins, order, box.start, cut);
    boxes.push(measureBox(bins, order, cut, box.end));
  }
  return boxes.map((box) => [box.mean[0], box.mean[1], box.mean[2]]);
}

function measureBox(bins, order, start, end) {
  const { weight, color } = bins;
  let w = 0;
  const sum = [0, 0, 0];
  const square = [0, 0, 0];
  for (let k = start; k < end; k++) {
    const i = order[k];
    const bw = weight[i];
    w += bw;
    for (let c = 0; c < 3; c++) {
      const v = color[i * 3 + c];
      sum[c] += bw * v;
      square[c] += bw * v * v;
    }
  }
  const mean = sum.map((s) => s / w);
  const spread = square.map((s, c) => s - (sum[c] * sum[c]) / w);
  const axis = spread.indexOf(Math.max(...spread));
  const error = end - start > 1 ? spread[0] + spread[1] + spread[2] : 0;
  return { start, end, mean, axis, error };
}

// 칸 좌표가 0~63 이라 계수 정렬로 충분하다.
function sortByCell(bins, order, scratch, start, end, axis) {
  const tally = new Int32Array(SIDE + 1);
  for (let k = start; k < end; k++) tally[bins.cell[order[k] * 3 + axis] + 1]++;
  for (let v = 1; v <= SIDE; v++) tally[v] += tally[v - 1];
  for (let k = start; k < end; k++) {
    const i = order[k];
    scratch[start + tally[bins.cell[i * 3 + axis]]++] = i;
  }
  order.set(scratch.subarray(start, end), start);
}

function bestCut(bins, order, start, end) {
  const { weight, color } = bins;
  let totalW = 0;
  let totalR = 0;
  let totalG = 0;
  let totalB = 0;
  for (let k = start; k < end; k++) {
    const i = order[k];
    totalW += weight[i];
    totalR += weight[i] * color[i * 3];
    totalG += weight[i] * color[i * 3 + 1];
    totalB += weight[i] * color[i * 3 + 2];
  }

  // 제곱 오차 합 = Σw|c|² - |Σwc|²/Σw 인데, 첫 항은 어디서 자르든 같으므로 두 번째 항이 가장 커지는 자리를 찾는다.
  let best = start + 1;
  let bestScore = -Infinity;
  let w = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let k = start; k < end - 1; k++) {
    const i = order[k];
    w += weight[i];
    r += weight[i] * color[i * 3];
    g += weight[i] * color[i * 3 + 1];
    b += weight[i] * color[i * 3 + 2];
    const restW = totalW - w;
    const score =
      (r * r + g * g + b * b) / w +
      ((totalR - r) ** 2 + (totalG - g) ** 2 + (totalB - b) ** 2) / restW;
    if (score > bestScore) {
      bestScore = score;
      best = k + 1;
    }
  }
  return best;
}

// 각 칸을 가장 가까운 대표색에 붙이고, 대표색을 붙은 칸들의 가중 평균으로 옮긴다.
function refine(bins, centers) {
  const { count, weight, color } = bins;
  const k = centers.length;
  const flat = new Float64Array(k * 3);
  centers.forEach((center, j) => flat.set(center, j * 3));
  const acc = new Float64Array(k * 4);

  for (let i = 0; i < count; i++) {
    const r = color[i * 3];
    const g = color[i * 3 + 1];
    const b = color[i * 3 + 2];
    let best = 0;
    let bestDistance = Infinity;
    for (let j = 0, f = 0; j < k; j++, f += 3) {
      const distance = (r - flat[f]) ** 2 + (g - flat[f + 1]) ** 2 + (b - flat[f + 2]) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = j;
      }
    }
    const w = weight[i];
    acc[best * 4] += w;
    acc[best * 4 + 1] += w * r;
    acc[best * 4 + 2] += w * g;
    acc[best * 4 + 3] += w * b;
  }

  for (let j = 0; j < k; j++) {
    const w = acc[j * 4];
    if (w > 0) centers[j] = [acc[j * 4 + 1] / w, acc[j * 4 + 2] / w, acc[j * 4 + 3] / w];
  }
}

function binsAsPalette({ count, color }) {
  const palette = [];
  for (let i = 0; i < count; i++) {
    palette.push([Math.round(color[i * 3]), Math.round(color[i * 3 + 1]), Math.round(color[i * 3 + 2])]);
  }
  return palette;
}

function centersAsPalette(centers) {
  return centers.map((center) => center.map(Math.round));
}
