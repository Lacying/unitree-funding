(() => {
  const HOUR = 3600000;
  const API = "https://api.hyperliquid.xyz/info";
  const coins = ["para:UNITREE", "xyz:UNITREE"];
  const $ = id => document.getElementById(id);
  const svgNS = "http://www.w3.org/2000/svg";
  const formatTime = time => new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).format(time);
  const formatRate = rate => rate == null ? "--" : `${rate > 0 ? "+" : ""}${(rate * 100).toFixed(5)}%`;
  const rateClass = value => value > 0 ? "positive" : value < 0 ? "negative" : "";
  const status = $("status");
  const refresh = $("refresh");
  const body = $("history-body");
  const periodButtons = [...document.querySelectorAll("[data-hours]")];
  let hours = 168;
  let records = [];
  let selectedTime = null;
  let activeRequest = null;
  let requestNumber = 0;

  const theme = () => {
    document.documentElement.dataset.theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  };
  theme();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", theme);
  for (const id of ["chart", "spread-chart"]) {
    new ResizeObserver(() => { if (records.length) renderChart(id); }).observe($(id));
  }

  function select(record) {
    if (!record) return;
    selectedTime = record.time;
    $("selected-time").textContent = formatTime(record.time);
    $("selected-para").textContent = formatRate(record.para);
    $("selected-xyz").textContent = formatRate(record.xyz);
    $("selected-net").textContent = formatRate(record.net);
    $("selected-spread").textContent = record.spread == null ? "--" : `${record.spread > 0 ? "+" : ""}${record.spread.toFixed(4)}%`;
    body.querySelector(".selected-row")?.classList.remove("selected-row");
    body.querySelector(`[data-time="${record.time}"]`)?.classList.add("selected-row");
    document.querySelectorAll(".chart svg").forEach(svg => svg.setSelection?.(record));
  }

  async function post(payload, signal) {
    const response = await fetch(API, {
      method: "POST", signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    if (!Array.isArray(result)) throw new Error("返回了无效数据");
    return result;
  }

  async function fetchHistory(coin, start, end, signal) {
    const rows = [];
    let next = start;
    // fundingHistory caps each response at 500 entries; advance by timestamp for 30 days.
    while (next <= end) {
      const page = await post({ type: "fundingHistory", coin, startTime: next, endTime: end }, signal);
      rows.push(...page);
      if (page.length < 500) break;
      const last = Number(page.at(-1)?.time);
      if (!Number.isFinite(last) || last < next) throw new Error(`${coin} 分页时间无效`);
      next = last + 1;
    }
    return rows;
  }

  async function fetchCandles(coin, start, end, signal) {
    const rows = await post({
      type: "candleSnapshot",
      req: { coin, interval: "1h", startTime: start - HOUR, endTime: end }
    }, signal);
    return new Map(rows
      .filter(row => Number.isFinite(Number(row.t)) && Number(row.c) > 0)
      .map(row => [Number(row.t) + HOUR, Number(row.c)]));
  }

  function renderTable() {
    body.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (const record of [...records].reverse()) {
      const tr = document.createElement("tr");
      tr.dataset.time = String(record.time);
      tr.tabIndex = 0;
      tr.setAttribute("aria-label", `${formatTime(record.time)}，para ${formatRate(record.para)}，xyz ${formatRate(record.xyz)}，净费率 ${formatRate(record.net)}，收盘价差 ${record.spread == null ? "--" : `${record.spread.toFixed(4)}%`}`);
      const cells = [
        formatTime(record.time), formatRate(record.para), formatRate(record.xyz), formatRate(record.net),
        record.spread == null ? "--" : `${record.spread > 0 ? "+" : ""}${record.spread.toFixed(4)}%`
      ];
      cells.forEach((text, index) => {
        const cell = document.createElement("td");
        cell.textContent = text;
        if (index === 3 && record.net != null) cell.className = rateClass(record.net);
        tr.append(cell);
      });
      tr.addEventListener("click", () => select(record));
      tr.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          select(record);
        }
      });
      fragment.append(tr);
    }
    body.append(fragment);
    $("row-count").textContent = `${records.length} 小时`;
  }

  function element(parent, name, attrs = {}, text) {
    const node = document.createElementNS(svgNS, name);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    if (text != null) node.textContent = text;
    parent.append(node);
    return node;
  }

  // Monotone cubic interpolation retains hourly values without overshooting peaks.
  function curve(points) {
    if (points.length < 2) return points.length ? `M ${points[0].x} ${points[0].y}` : "";
    const slopes = points.slice(1).map((point, i) => (point.y - points[i].y) / (point.x - points[i].x));
    const tangents = points.map((_, i) => {
      if (i === 0) return slopes[0];
      if (i === points.length - 1) return slopes.at(-1);
      return slopes[i - 1] * slopes[i] <= 0 ? 0 : Math.sign(slopes[i]) * Math.min(Math.abs(slopes[i - 1]), Math.abs(slopes[i]));
    });
    return points.slice(1).reduce((path, point, i) => {
      const previous = points[i];
      const dx = (point.x - previous.x) / 3;
      return `${path} C ${previous.x + dx} ${previous.y + tangents[i] * dx}, ${point.x - dx} ${point.y - tangents[i + 1] * dx}, ${point.x} ${point.y}`;
    }, `M ${points[0].x} ${points[0].y}`);
  }

  function renderChart(id) {
    const root = $(id);
    const width = Math.max(root.clientWidth, 300);
    const height = root.clientHeight;
    const margin = { left: 58, right: 18, top: 22, bottom: 38 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const fields = id === "chart" ? [["para", "--para"], ["xyz", "--xyz"]] : [["spread", "--spread"]];
    const valueOf = (record, field) => record[field] == null ? null : field === "spread" ? record[field] : record[field] * 100;
    const values = fields.flatMap(([field]) => records.map(record => valueOf(record, field)).filter(value => value != null));
    if (!values.length) {
      root.replaceChildren();
      return;
    }
    let min = Math.min(...values), max = Math.max(...values);
    const padding = (max - min || Math.max(Math.abs(max) * .2, .001)) * .12;
    min -= padding;
    max += padding;
    const x = index => margin.left + index * plotWidth / Math.max(records.length - 1, 1);
    const y = value => margin.top + (max - value) * plotHeight / (max - min);
    const svg = element(document.createDocumentFragment(), "svg", { viewBox: `0 0 ${width} ${height}`, "aria-hidden": "true" });
    for (let i = 0; i <= 4; i++) {
      const at = margin.top + i * plotHeight / 4;
      element(svg, "line", { x1: margin.left, x2: width - margin.right, y1: at, y2: at, class: "grid-line" });
      element(svg, "text", { x: margin.left - 8, y: at + 4, "text-anchor": "end", class: "axis-label" },
        `${(max - (max - min) * i / 4).toFixed(id === "chart" ? 3 : 2)}%`);
    }
    const labelCount = width < 500 ? 2 : hours <= 4 ? 4 : 5;
    const labels = Array.from({ length: labelCount }, (_, i) => Math.round(i * (records.length - 1) / (labelCount - 1)));
    for (const index of [...new Set(labels)]) {
      const at = x(index);
      element(svg, "line", { x1: at, x2: at, y1: height - margin.bottom, y2: height - margin.bottom + 7, class: "calendar-tick" });
      element(svg, "text", { x: at, y: height - 12, "text-anchor": index === 0 ? "start" : index === records.length - 1 ? "end" : "middle", class: "axis-label" },
        formatTime(records[index].time));
    }
    const step = hours <= 24 ? 1 : hours <= 168 ? 6 : 24;
    for (let i = 0; i < records.length; i += step) {
      element(svg, "line", { x1: x(i), x2: x(i), y1: height - margin.bottom, y2: height - margin.bottom - 5, class: "calendar-tick" });
    }
    const markers = [];
    for (const [field, color] of fields) {
      let segment = [];
      const flush = () => {
        if (segment.length > 1) element(svg, "path", { d: curve(segment), stroke: `var(${color})`, class: "data-line" });
        else if (segment.length === 1) element(svg, "circle", { cx: segment[0].x, cy: segment[0].y, r: 2, fill: `var(${color})` });
        segment = [];
      };
      records.forEach((record, index) => {
        const value = valueOf(record, field);
        if (value == null) flush();
        else segment.push({ x: x(index), y: y(value) });
      });
      flush();
      const marker = element(svg, "circle", { r: 5, fill: `var(${color})`, class: "data-dot", visibility: "hidden" });
      markers.push([field, marker]);
    }
    const hit = element(svg, "rect", {
      x: margin.left, y: margin.top, width: plotWidth, height: plotHeight, class: "hit-area"
    });
    const crosshair = element(svg, "g", { class: "crosshair", visibility: "hidden" });
    const vertical = element(crosshair, "line", {
      y1: margin.top, y2: height - margin.bottom
    });
    const horizontal = element(crosshair, "line", {
      x1: margin.left, x2: width - margin.right
    });
    svg.setSelection = record => {
      const index = records.findIndex(row => row.time === record.time);
      if (index < 0) return;
      for (const [field, marker] of markers) {
        const value = valueOf(record, field);
        marker.setAttribute("visibility", value == null ? "hidden" : "visible");
        if (value != null) {
          marker.setAttribute("cx", x(index));
          marker.setAttribute("cy", y(value));
        }
      }
    };
    svg.setCrosshair = (index, chartY) => {
      vertical.setAttribute("x1", x(index));
      vertical.setAttribute("x2", x(index));
      horizontal.setAttribute("y1", chartY);
      horizontal.setAttribute("y2", chartY);
      crosshair.setAttribute("visibility", "visible");
    };
    svg.hideCrosshair = () => crosshair.setAttribute("visibility", "hidden");
    hit.addEventListener("pointermove", event => {
      const rect = svg.getBoundingClientRect();
      const chartX = (event.clientX - rect.left) * width / rect.width;
      const chartY = Math.min(height - margin.bottom, Math.max(margin.top, (event.clientY - rect.top) * height / rect.height));
      const index = Math.min(records.length - 1, Math.max(0, Math.round((chartX - margin.left) * (records.length - 1) / plotWidth)));
      select(records[index]);
      svg.setCrosshair(index, chartY);
    });
    hit.addEventListener("pointerleave", svg.hideCrosshair);
    root.replaceChildren(svg);
    if (selectedTime != null) svg.setSelection(records.find(record => record.time === selectedTime) || records.at(-1));
  }

  async function load(clear = false) {
    activeRequest?.abort();
    if (clear) {
      records = [];
      body.innerHTML = '<tr><td colspan="5" class="empty">正在加载...</td></tr>';
      $("chart").replaceChildren();
      $("spread-chart").replaceChildren();
      $("row-count").textContent = "";
      for (const id of ["para-total", "xyz-total", "net-total"]) {
        $(id).textContent = "--";
        $(id).className = "";
      }
    }
    const controller = new AbortController();
    activeRequest = controller;
    const current = ++requestNumber;
    refresh.disabled = true;
    status.classList.remove("error");
    status.textContent = "正在获取历史资金费...";
    try {
      const end = Math.floor(Date.now() / HOUR) * HOUR;
      const start = end - (hours - 1) * HOUR;
      const [results, candles] = await Promise.all([
        Promise.all(coins.map(coin => fetchHistory(coin, start, end + HOUR - 1, controller.signal))),
        Promise.allSettled(coins.map(coin => fetchCandles(coin, start, end, controller.signal)))
      ]);
      if (current !== requestNumber) return;
      const maps = results.map(rows => new Map(rows
        .filter(row => Number.isFinite(Number(row.time)) && Number.isFinite(Number(row.fundingRate)))
        .map(row => [Math.floor(Number(row.time) / HOUR) * HOUR, Number(row.fundingRate)])));
      const prices = candles.map(result => result.status === "fulfilled" ? result.value : new Map());
      records = Array.from({ length: hours }, (_, index) => {
        const time = start + index * HOUR;
        const para = maps[0].get(time) ?? null;
        const xyz = maps[1].get(time) ?? null;
        const paraClose = prices[0].get(time);
        const xyzClose = prices[1].get(time);
        const spread = paraClose && xyzClose ? 2 * (xyzClose - paraClose) / (xyzClose + paraClose) * 100 : null;
        return { time, para, xyz, net: para == null || xyz == null ? null : xyz - para, spread };
      });
      if (!records.some(row => row.para != null || row.xyz != null)) throw new Error("这段时间没有历史资金费");
      const paired = records.filter(row => row.net != null);
      for (const [id, key] of [["para-total", "para"], ["xyz-total", "xyz"], ["net-total", "net"]]) {
        const available = paired.map(row => row[key]);
        const total = available.reduce((sum, value) => sum + value, 0);
        const node = $(id);
        node.textContent = available.length ? formatRate(total) : "--";
        node.className = available.length ? rateClass(total) : "";
      }
      renderTable();
      renderChart("chart");
      renderChart("spread-chart");
      select(records.find(row => row.time === selectedTime) || [...records].reverse().find(row => row.para != null || row.xyz != null));
      const spreadCount = records.filter(row => row.spread != null).length;
      status.textContent = `${formatTime(start)} 至 ${formatTime(end)} / ${paired.length} 个共同结算小时 / ${spreadCount} 个收盘价差 / 更新于 ${formatTime(Date.now())}`;
      if (candles.some(result => result.status === "rejected")) {
        status.classList.add("error");
        status.textContent += " / K 线获取失败，请刷新重试";
      }
    } catch (error) {
      if (current !== requestNumber) return;
      status.classList.add("error");
      status.textContent = `获取失败：${error.message}。请点击刷新重试。`;
      if (!records.length) body.innerHTML = '<tr><td colspan="5" class="empty">暂无数据</td></tr>';
    } finally {
      if (current === requestNumber) refresh.disabled = false;
    }
  }

  periodButtons.forEach(button => button.addEventListener("click", () => {
    const next = Number(button.dataset.hours);
    if (next === hours) return;
    hours = next;
    selectedTime = null;
    periodButtons.forEach(item => item.setAttribute("aria-pressed", String(item === button)));
    load(true);
  }));
  refresh.addEventListener("click", () => load());
  load();
})();
