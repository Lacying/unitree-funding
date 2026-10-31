(() => {
  const HOUR = 3600000;
  const API = "https://api.hyperliquid.xyz/info";
  let coins = ["para:UNITREE", "xyz:UNITREE"];
  let markets = new Map();
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
  const assetSelect = $("asset");
  const longSelect = $("long-market");
  const shortSelect = $("short-market");
  const periodButtons = [...document.querySelectorAll("[data-hours]")];
  const marketPickers = new Map();
  let openPicker = null;
  let hours = 168;
  let records = [];
  let selectedTime = null;
  let activeRequest = null;
  let requestNumber = 0;
  let requestsInFlight = 0;
  const pendingRequests = [];

  function waitForSlot(signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (requestsInFlight < 2) {
      requestsInFlight++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal };
      entry.abort = () => {
        const index = pendingRequests.indexOf(entry);
        if (index !== -1) pendingRequests.splice(index, 1);
        reject(signal.reason);
      };
      signal?.addEventListener("abort", entry.abort, { once: true });
      pendingRequests.push(entry);
    });
  }

  function releaseSlot() {
    const next = pendingRequests.shift();
    if (next) {
      next.signal?.removeEventListener("abort", next.abort);
      next.resolve();
    } else {
      requestsInFlight--;
    }
  }

  function pause(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const timer = setTimeout(done, ms);
      function done() {
        signal?.removeEventListener("abort", abort);
        resolve();
      }
      function abort() {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      }
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  const venue = coin => coin.includes(":") ? coin.slice(0, coin.indexOf(":")) : "Hyperliquid";
  const assetOf = coin => coin.includes(":") ? coin.slice(coin.indexOf(":") + 1) : coin;

  function syncPicker(select) {
    const picker = marketPickers.get(select);
    if (!picker) return;
    const { button, value, list } = picker;
    value.textContent = select.selectedOptions[0]?.textContent || "--";
    button.setAttribute("aria-label", `${select.getAttribute("aria-label")}：${value.textContent}`);
    button.disabled = select.disabled;
    list.replaceChildren(...[...select.options].map((item, index) => {
      const option = document.createElement("div");
      option.id = `${select.id}-option-${index}`;
      option.className = "market-option";
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(item.selected));
      option.dataset.value = item.value;
      option.textContent = item.textContent;
      return option;
    }));
  }

  function closeMarketPicker() {
    if (!openPicker) return;
    const { button, list } = marketPickers.get(openPicker);
    list.hidden = true;
    button.setAttribute("aria-expanded", "false");
    button.removeAttribute("aria-activedescendant");
    openPicker = null;
  }

  function initPicker(select) {
    const picker = document.createElement("div");
    picker.className = "market-picker";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "market-trigger";
    button.setAttribute("role", "combobox");
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-controls", `${select.id}-options`);
    button.setAttribute("aria-expanded", "false");
    const value = document.createElement("span");
    value.className = "market-value";
    const arrow = document.createElementNS(svgNS, "svg");
    arrow.setAttribute("viewBox", "0 0 24 24");
    arrow.setAttribute("aria-hidden", "true");
    const chevron = document.createElementNS(svgNS, "path");
    chevron.setAttribute("d", "m6 9 6 6 6-6");
    arrow.append(chevron);
    button.append(value, arrow);
    const list = document.createElement("div");
    list.id = `${select.id}-options`;
    list.className = "market-options";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", select.getAttribute("aria-label"));
    list.hidden = true;
    picker.append(button, list);
    select.after(picker);
    select.hidden = true;
    marketPickers.set(select, { button, value, list, active: 0 });
    syncPicker(select);

    function highlight(index) {
      const state = marketPickers.get(select);
      const options = [...list.children];
      if (!options.length) return;
      state.active = Math.max(0, Math.min(options.length - 1, index));
      const option = options[state.active];
      button.setAttribute("aria-activedescendant", option.id);
      for (const item of options) item.classList.toggle("active", item === option);
      if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
      else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) {
        list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
      }
    }

    function open() {
      if (button.disabled) return;
      closeMarketPicker();
      list.hidden = false;
      button.setAttribute("aria-expanded", "true");
      openPicker = select;
      highlight(select.selectedIndex);
      requestAnimationFrame(() => {
        if (openPicker !== select) return;
        const overflow = list.getBoundingClientRect().bottom - innerHeight + 12;
        if (overflow > 0) scrollBy({ top: overflow, behavior: "auto" });
      });
    }

    function choose(option) {
      if (!option || option.dataset.value === select.value) {
        closeMarketPicker();
        return;
      }
      select.value = option.dataset.value;
      closeMarketPicker();
      select.dispatchEvent(new Event("change", { bubbles: true }));
      for (const item of [assetSelect, longSelect, shortSelect]) syncPicker(item);
      button.focus({ preventScroll: true });
    }

    button.addEventListener("click", () => openPicker === select ? closeMarketPicker() : open());
    button.addEventListener("keydown", event => {
      const state = marketPickers.get(select);
      if (event.key === "Escape" && openPicker === select) {
        event.preventDefault();
        closeMarketPicker();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
        event.preventDefault();
        if (openPicker !== select) open();
        else highlight(event.key === "Home" ? 0 : event.key === "End" ? list.children.length - 1
          : state.active + (event.key === "ArrowDown" ? 1 : -1));
      } else if (event.key === "Enter" && openPicker === select) {
        event.preventDefault();
        choose(list.children[state.active]);
      } else if (event.key === " " && openPicker === select) {
        event.preventDefault();
        choose(list.children[state.active]);
      } else if (event.key === "Tab") {
        closeMarketPicker();
      } else if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
        const match = [...list.children].findIndex(option =>
          option.dataset.value.toLowerCase().startsWith(event.key.toLowerCase()));
        if (match !== -1) {
          event.preventDefault();
          if (openPicker !== select) open();
          highlight(match);
        }
      }
    });
    list.addEventListener("click", event => choose(event.target.closest(".market-option")));
    list.addEventListener("pointermove", event => {
      const option = event.target.closest(".market-option");
      if (option && list.contains(option)) highlight([...list.children].indexOf(option));
    });
  }

  function setOptions(select, values, selected) {
    select.replaceChildren(...values.map(value => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      return option;
    }));
    select.value = selected;
    syncPicker(select);
  }

  function updateLabels() {
    const [long, short] = coins.map(venue);
    const asset = assetOf(coins[0]);
    $("page-title").textContent = `${asset} 资金费对比`;
    document.title = `${asset} 资金费对比`;
    $("context").textContent = `Hyperliquid / ${coins[0]} 与 ${coins[1]} / 北京时间`;
    $("long-total-label").textContent = `${long} 累计费率`;
    $("short-total-label").textContent = `${short} 累计费率`;
    $("net-total-label").textContent = `多 ${long} / 空 ${short} 净费率`;
    for (const id of ["long-legend", "selected-long-label", "long-column"]) $(id).textContent = long;
    for (const id of ["short-legend", "selected-short-label", "short-column"]) $(id).textContent = short;
    $("net-column").textContent = `多 ${long} / 空 ${short} 净费率`;
    $("spread-legend").textContent = `${short} - ${long}`;
    $("chart").setAttribute("aria-label", `${long} 和 ${short} 每小时资金费率曲线图`);
    $("spread-chart").setAttribute("aria-label", `${short} 与 ${long} 每小时收盘价差曲线图`);
    $("note").textContent = `负费率为空头支付给多头。净费率 = ${short} 费率 - ${long} 费率。收盘价差 = 2 × (${short} 收盘价 - ${long} 收盘价) / 两腿收盘价之和；使用上一小时 K 线收盘价，不是可成交的开仓差价。历史费率未计入手续费和价格变化。`;
  }

  function chooseMarkets(asset, preferred = []) {
    const available = markets.get(asset);
    if (!available?.length) return;
    const first = available.includes(preferred[0]) ? preferred[0] : available[0];
    const second = available.includes(preferred[1]) && preferred[1] !== first
      ? preferred[1] : available.find(coin => coin !== first);
    setOptions(longSelect, available, first);
    setOptions(shortSelect, available, second);
    setPair(first, second);
  }

  function setPair(long, short) {
    if (!long || !short || long === short) return;
    longSelect.value = long;
    shortSelect.value = short;
    syncPicker(longSelect);
    syncPicker(shortSelect);
    if (coins[0] === long && coins[1] === short) return;
    coins = [long, short];
    selectedTime = null;
    updateLabels();
    load(true);
  }

  async function loadMarkets() {
    try {
      const metas = await post({ type: "allPerpMetas" });
      const available = new Map();
      for (const meta of metas) {
        for (const contract of meta?.universe || []) {
          if (typeof contract.name !== "string" || contract.isDelisted) continue;
          const asset = assetOf(contract.name);
          if (!available.has(asset)) available.set(asset, new Set());
          available.get(asset).add(contract.name);
        }
      }
      markets = new Map([...available]
        .filter(([, contracts]) => contracts.size >= 2)
        .map(([asset, contracts]) => [asset, [...contracts].sort((a, b) => a.localeCompare(b))]));
      if (!markets.has("UNITREE")) markets.set("UNITREE", [...coins]);
      setOptions(assetSelect, [...markets.keys()].sort((a, b) => a.localeCompare(b)), assetSelect.value);
      if (!markets.has(assetSelect.value)) assetSelect.value = "UNITREE";
      chooseMarkets(assetSelect.value, coins);
    } catch (error) {
      // The default pair remains usable if the market directory is unavailable.
      status.textContent += ` / 币种列表获取失败：${error.message}`;
    } finally {
      assetSelect.disabled = false;
      longSelect.disabled = false;
      shortSelect.disabled = false;
      for (const select of [assetSelect, longSelect, shortSelect]) syncPicker(select);
    }
  }

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
    await waitForSlot(signal);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetch(API, {
            method: "POST", signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          if (!response.ok) {
            if (![429, 502, 503, 504].includes(response.status) || attempt === 2) {
              throw new Error(`HTTP ${response.status}`);
            }
          } else {
            const result = await response.json();
            if (!Array.isArray(result)) throw new Error("返回了无效数据");
            return result;
          }
        } catch (error) {
          if (signal?.aborted || !(error instanceof TypeError) || attempt === 2) throw error;
        }
        await pause(500 * 3 ** attempt, signal);
      }
    } finally {
      releaseSlot();
    }
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
      tr.setAttribute("aria-label", `${formatTime(record.time)}，${venue(coins[0])} ${formatRate(record.para)}，${venue(coins[1])} ${formatRate(record.xyz)}，净费率 ${formatRate(record.net)}，收盘价差 ${record.spread == null ? "--" : `${record.spread.toFixed(4)}%`}`);
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
      selectedTime = null;
      body.innerHTML = '<tr><td colspan="5" class="empty">正在加载...</td></tr>';
      $("chart").replaceChildren();
      $("spread-chart").replaceChildren();
      $("row-count").textContent = "";
      for (const id of ["selected-time", "selected-para", "selected-xyz", "selected-net", "selected-spread"]) {
        $(id).textContent = "--";
      }
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
      if (!paired.length) {
        status.classList.add("error");
        status.textContent += " / 两腿暂无共同结算数据";
      }
      if (candles.some(result => result.status === "rejected")) {
        status.classList.add("error");
        status.textContent += " / K 线获取失败，请刷新重试";
      }
    } catch (error) {
      if (current !== requestNumber) return;
      status.classList.add("error");
      status.textContent = error instanceof TypeError
        ? "连接 Hyperliquid 失败，请稍后刷新重试。"
        : `获取失败：${error.message}。请点击刷新重试。`;
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
  assetSelect.addEventListener("change", () => chooseMarkets(assetSelect.value));
  longSelect.addEventListener("change", () => {
    const long = longSelect.value;
    const short = shortSelect.value === long
      ? markets.get(assetSelect.value).find(coin => coin !== long) : shortSelect.value;
    setPair(long, short);
  });
  shortSelect.addEventListener("change", () => {
    const short = shortSelect.value;
    const long = longSelect.value === short
      ? markets.get(assetSelect.value).find(coin => coin !== short) : longSelect.value;
    setPair(long, short);
  });
  refresh.addEventListener("click", () => load());
  assetSelect.disabled = true;
  longSelect.disabled = true;
  shortSelect.disabled = true;
  for (const select of [assetSelect, longSelect, shortSelect]) initPicker(select);
  document.addEventListener("pointerdown", event => {
    if (openPicker && !marketPickers.get(openPicker).button.parentElement.contains(event.target)) {
      closeMarketPicker();
    }
  });
  document.addEventListener("focusin", event => {
    if (openPicker && !marketPickers.get(openPicker).button.parentElement.contains(event.target)) {
      closeMarketPicker();
    }
  });
  updateLabels();
  loadMarkets();
  load();
})();
