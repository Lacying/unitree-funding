(() => {
  const HOUR = 3600000;
  const HOURS = 168;
  const API = "https://api.hyperliquid.xyz/info";
  const coins = ["para:UNITREE", "xyz:UNITREE"];
  const $ = id => document.getElementById(id);
  const formatTime = time => new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).format(time);
  const formatRate = rate => rate == null ? "--" : `${rate > 0 ? "+" : ""}${(rate * 100).toFixed(5)}%`;
  const rateClass = value => value > 0 ? "positive" : value < 0 ? "negative" : "";
  const theme = () => {
    document.documentElement.dataset.theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    if (records.length) renderChart();
  };

  const status = $("status");
  const refresh = $("refresh");
  const body = $("history-body");
  let charts = [];
  let records = [];
  let selectedTime = null;
  theme();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", theme);

  function select(record) {
    if (!record) return;
    selectedTime = record.time;
    $("selected-time").textContent = formatTime(record.time);
    $("selected-para").textContent = formatRate(record.para);
    $("selected-xyz").textContent = formatRate(record.xyz);
    $("selected-net").textContent = formatRate(record.net);
    $("selected-spread").textContent = record.spread == null ? "--" : `${record.spread > 0 ? "+" : ""}${record.spread.toFixed(4)}%`;
    body.querySelector(".selected-row")?.classList.remove("selected-row");
    const row = body.querySelector(`[data-time="${record.time}"]`);
    row?.classList.add("selected-row");
  }

  async function fetchHistory(coin, start, end) {
    const response = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "fundingHistory", coin, startTime: start, endTime: end })
    });
    if (!response.ok) throw new Error(`${coin} HTTP ${response.status}`);
    const result = await response.json();
    if (!Array.isArray(result)) throw new Error(`${coin} 返回了无效数据`);
    return result;
  }

  async function fetchCandles(coin, start, end) {
    const response = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval: "1h", startTime: start - HOUR, endTime: end } })
    });
    if (!response.ok) throw new Error(`${coin} K 线 HTTP ${response.status}`);
    const result = await response.json();
    if (!Array.isArray(result)) throw new Error(`${coin} K 线数据无效`);
    return new Map(result
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
        formatTime(record.time), formatRate(record.para),
        formatRate(record.xyz), formatRate(record.net),
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

  function renderChart() {
    charts.forEach(({ chart, observer }) => {
      observer.disconnect();
      chart.remove();
    });
    charts = [];
    const css = getComputedStyle(document.documentElement);
    const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    const color = variable => {
      context.fillStyle = css.getPropertyValue(variable).trim();
      context.fillRect(0, 0, 1, 1);
      const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
      return `rgb(${r}, ${g}, ${b})`;
    };
    for (const [id, fields] of [
      ["chart", [["para", "--para"], ["xyz", "--xyz"]]],
      ["spread-chart", [["spread", "--spread"]]]
    ]) {
      const root = $(id);
      const chart = LightweightCharts.createChart(root, {
        width: root.clientWidth,
        height: root.clientHeight,
        layout: { background: { type: "solid", color: color("--surface") }, textColor: color("--muted"), fontSize: 12 },
        grid: { vertLines: { color: color("--slate-3") }, horzLines: { color: color("--slate-3") } },
        rightPriceScale: { borderColor: color("--line"), scaleMargins: { top: .12, bottom: .12 } },
        timeScale: { borderColor: color("--line"), timeVisible: true, secondsVisible: false, rightOffset: 2,
          tickMarkFormatter: time => formatTime(time * 1000) },
        localization: { priceFormatter: value => `${value.toFixed(3)}%`, timeFormatter: time => formatTime(time * 1000) },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal }
      });
      for (const [field, variable] of fields) {
        const series = chart.addSeries(LightweightCharts.LineSeries, {
          color: color(variable), lineWidth: 2, priceLineVisible: false, lastValueVisible: false,
          crosshairMarkerRadius: 4
        });
        series.setData(records.map(row => row[field] == null
          ? { time: row.time / 1000 }
          : { time: row.time / 1000, value: field === "spread" ? row[field] : row[field] * 100 }));
      }
      chart.timeScale().fitContent();
      chart.subscribeCrosshairMove(param => {
        if (typeof param.time !== "number") return;
        select(records.find(row => row.time === param.time * 1000));
      });
      const observer = new ResizeObserver(() => {
        chart.resize(root.clientWidth, root.clientHeight);
        chart.timeScale().fitContent();
      });
      observer.observe(root);
      charts.push({ chart, observer });
    }
  }

  async function load() {
    refresh.disabled = true;
    status.classList.remove("error");
    status.textContent = "正在获取历史资金费...";
    try {
      const end = Math.floor(Date.now() / HOUR) * HOUR;
      const start = end - (HOURS - 1) * HOUR;
      const [results, candles] = await Promise.all([
        Promise.all(coins.map(coin => fetchHistory(coin, start, end + HOUR - 1))),
        Promise.allSettled(coins.map(coin => fetchCandles(coin, start, end)))
      ]);
      const maps = results.map(rows => new Map(rows
        .filter(row => Number.isFinite(Number(row.time)) && Number.isFinite(Number(row.fundingRate)))
        .map(row => [Math.floor(Number(row.time) / HOUR) * HOUR, Number(row.fundingRate)])));
      const prices = candles.map(result => result.status === "fulfilled" ? result.value : new Map());
      records = Array.from({ length: HOURS }, (_, index) => {
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
        const node = $(id);
        node.textContent = available.length ? formatRate(available.reduce((sum, value) => sum + value, 0)) : "--";
        node.className = rateClass(available.reduce((sum, value) => sum + value, 0));
      }
      renderTable();
      renderChart();
      select(records.find(row => row.time === selectedTime) || [...records].reverse().find(row => row.para != null || row.xyz != null));
      const spreadCount = records.filter(row => row.spread != null).length;
      status.textContent = `${formatTime(start)} 至 ${formatTime(end)} / ${paired.length} 个共同结算小时 / ${spreadCount} 个收盘价差 / 更新于 ${formatTime(Date.now())}`;
      if (candles.some(result => result.status === "rejected")) {
        status.classList.add("error");
        status.textContent += " / K 线获取失败，请刷新重试";
      }
    } catch (error) {
      status.classList.add("error");
      status.textContent = `获取失败：${error.message}。请点击刷新重试。`;
      if (!records.length) body.innerHTML = '<tr><td colspan="5" class="empty">暂无数据</td></tr>';
    } finally {
      refresh.disabled = false;
    }
  }

  refresh.addEventListener("click", load);
  load();
})();
