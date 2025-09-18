(function(){
  // ===== Utilities =====
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Register service worker for offline/PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch(()=>{});
  }

  // Persistent storage keys
  const LS = {
    DIFF: 'ms_diff',
    BEST: 'ms_best_times_v1',
    SOUND: 'ms_sound',
    SAFE: 'ms_safe',
    ZERO: 'ms_zero',
    CUSTOM: 'ms_custom'
  };

  // Sound (optional, very subtle)
  const beeps = {
    ctx: null,
    play(freq=880, dur=0.05){
      if (!$('#soundToggle').checked) return;
      if (!this.ctx) this.ctx = new (window.AudioContext||window.webkitAudioContext)();
      const t0 = this.ctx.currentTime;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.frequency.value = freq;
      o.type = 'triangle';
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.07, t0+0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(this.ctx.destination);
      o.start(t0);
      o.stop(t0 + dur);
    }
  };

  // ===== Game State =====
  let cols = 9, rows = 9, mines = 10;
  let board = [];           // 2D array of cells
  let started = false;
  let ended = false;
  let flags = 0;
  let revealedCount = 0;
  let timerId = null, elapsed = 0;
  let focusIndex = 0;       // for keyboard nav
  let holdTimer = null;     // long-press flagging

  const boardEl = $('#board');
  const minesLeftEl = $('#minesLeft');
  const timerEl = $('#timer');
  const resetBtn = $('#resetBtn');

  const difficulties = {
    beginner: {w:9, h:9, m:10},
    intermediate: {w:16, h:16, m:40},
    expert: {w:30, h:16, m:99},
  };

  // ===== Cell Factory =====
  function newCell(x,y){
    return {
      x,y,
      mine:false,
      revealed:false,
      flagged:false,
      count:0,
      el:null
    };
  }
  function inBounds(x,y){ return x>=0 && x<cols && y>=0 && y<rows; }
  function neighbors(x,y){
    const res=[];
    for (let dy=-1; dy<=1; dy++)
      for (let dx=-1; dx<=1; dx++){
        if (dx===0 && dy===0) continue;
        const nx=x+dx, ny=y+dy;
        if (inBounds(nx,ny)) res.push(board[ny][nx]);
      }
    return res;
  }

  // ===== Board Creation =====
  function setupGrid(){
    board = Array.from({length: rows}, (_, y) =>
      Array.from({length: cols}, (_, x) => newCell(x,y))
    );
    boardEl.innerHTML = '';
    boardEl.style.gridTemplateColumns = `repeat(${cols}, var(--cell-size))`;
    boardEl.setAttribute('aria-rowcount', rows);
    boardEl.setAttribute('aria-colcount', cols);

    // Auto-fit cells to viewport width (optional button also triggers)
    autoFitCells();

    // Create elements (defer mines until first click if safeFirst)
    let index = 0;
    for (let y=0; y<rows; y++){
      for (let x=0; x<cols; x++){
        const c = board[y][x];
        const el = document.createElement('button');
        el.className = 'cell';
        el.setAttribute('role','gridcell');
        el.setAttribute('aria-label','Hidden cell');
        el.dataset.x = x;
        el.dataset.y = y;
        el.dataset.index = index++;
        c.el = el;
        boardEl.appendChild(el);
      }
    }
    focusIndex = 0;
  }

  function placeMines(excludeCell){
    // Build pool of positions excluding the first clicked cell (and optionally its neighbors)
    const safeFirst = $('#safeFirst').checked;
    const exclude = new Set();
    if (safeFirst && excludeCell){
      exclude.add(key(excludeCell.x, excludeCell.y));
      neighbors(excludeCell.x, excludeCell.y).forEach(n => exclude.add(key(n.x,n.y)));
    }
    function key(x,y){ return `${x},${y}`; }

    const spots = [];
    for (let y=0;y<rows;y++) for (let x=0;x<cols;x++){
      const k = key(x,y);
      if (!exclude.has(k)) spots.push([x,y]);
    }
    shuffle(spots);

    for (let i=0; i<mines && i<spots.length; i++){
      const [mx,my] = spots[i];
      board[my][mx].mine = true;
    }
    // compute counts
    for (let y=0; y<rows; y++){
      for (let x=0; x<cols; x++){
        const c = board[y][x];
        if (c.mine) continue;
        c.count = neighbors(x,y).reduce((acc,n)=> acc + (n.mine?1:0), 0);
      }
    }
  }

  function shuffle(a){
    for (let i=a.length-1;i>0;i--){
      const j = (Math.random()* (i+1))|0;
      [a[i], a[j]] = [a[j], a[i]];
    }
  }

  // ===== Game Control =====
  function newGame(params){
    ended = false; started = false; elapsed = 0; flags = 0; revealedCount = 0;
    if (timerId) clearInterval(timerId); timerId = null;
    timerEl.textContent = fmt3(elapsed);
    resetBtn.textContent = '🙂';

    if (params){
      cols = params.w; rows = params.h; mines = params.m;
    }
    setupGrid();
    updateMinesLeft();
    updateBestText();
  }

  function startTimer(){
    if (timerId) return;
    timerId = setInterval(()=> {
      elapsed++; timerEl.textContent = fmt3(elapsed);
    }, 1000);
  }

  function endGame(win){
    ended = true;
    clearInterval(timerId); timerId = null;
    if (win){
      resetBtn.textContent = '😎';
      beeps.play(1200, .08);
      saveBestIfNeeded();
    } else {
      resetBtn.textContent = '💀';
      revealAllMines();
      beeps.play(220, .2);
    }
    for (let y=0;y<rows;y++) for (let x=0;x<cols;x++){
      const c = board[y][x];
      if (c.mine && !c.revealed){
        c.el.setAttribute('aria-label','Mine');
      }
    }
  }

  function revealAllMines(){
    for (let y=0;y<rows;y++) for (let x=0;x<cols;x++){
      const c = board[y][x];
      if (c.mine){ c.revealed = true; renderCell(c); }
    }
  }

  function fmt3(n){ return String(n).padStart(3,'0'); }

  function updateMinesLeft(){
    minesLeftEl.textContent = fmt3(Math.max(0, mines - flags));
  }

  // ===== Rendering =====
  function renderCell(c){
    const el = c.el;
    el.classList.toggle('revealed', c.revealed);
    el.classList.toggle('flag', c.flagged);
    el.classList.toggle('mine', c.mine);
    el.innerHTML = '';

    if (c.revealed){
      el.setAttribute('aria-pressed','true');
      if (c.mine){
        el.textContent = '💣';
        el.setAttribute('aria-label','Mine');
      } else if (c.count>0){
        const span = document.createElement('span');
        span.className = `num n${c.count}`;
        span.textContent = c.count;
        el.appendChild(span);
        el.setAttribute('aria-label', `${c.count} nearby mines`);
      } else {
        el.setAttribute('aria-label','Empty');
      }
    } else {
      el.removeAttribute('aria-pressed');
      el.setAttribute('aria-label', c.flagged ? 'Flagged' : 'Hidden cell');
    }
  }

  function renderAll(){
    for (let y=0;y<rows;y++) for (let x=0;x<cols;x++) renderCell(board[y][x]);
  }

  // ===== Actions =====
  function toggleFlag(c){
    if (ended || c.revealed) return;
    if (c.flagged) { c.flagged = false; flags--; beeps.play(400,.04); }
    else {
      if (flags < mines || c.flagged){ c.flagged = true; flags++; beeps.play(600,.04); }
    }
    updateMinesLeft();
    renderCell(c);
  }

  function reveal(c, fromChord=false){
    if (ended || c.revealed || c.flagged) return;
    if (!started){
      placeMines(c);
      started = true;
      startTimer();
    }
    c.revealed = true;
    revealedCount++;
    renderCell(c);
    beeps.play(880 + c.count*60, .03);

    if (c.mine){
      endGame(false);
      return;
    }

    if (c.count === 0 && $('#showZeros').checked){
      const q=[c];
      const seen = new Set([c]);
      while(q.length){
        const cur = q.shift();
        for (const n of neighbors(cur.x, cur.y)){
          if (n.revealed || n.flagged) continue;
          if (n.mine) continue;
          n.revealed = true; revealedCount++; renderCell(n);
          if (n.count===0 && !seen.has(n)){ q.push(n); seen.add(n); }
        }
      }
    }

    checkWin();
  }

  function chord(c){
    if (!c.revealed || c.mine || ended) return;
    const ns = neighbors(c.x,c.y);
    const flagged = ns.filter(n=>n.flagged).length;
    if (flagged === c.count){
      for (const n of ns){
        if (!n.revealed && !n.flagged){
          reveal(n, true);
          if (ended) return;
        }
      }
    } else {
      beeps.play(300, .02);
    }
  }

  function checkWin(){
    const nonMine = cols*rows - mines;
    if (revealedCount >= nonMine && !ended){
      endGame(true);
    }
  }

  // ===== Events =====
  boardEl.addEventListener('contextmenu', e => e.preventDefault());

  // Pointer handling with long-press
  boardEl.addEventListener('pointerdown', onPointerDown);
  boardEl.addEventListener('pointerup', onPointerUp);
  boardEl.addEventListener('pointercancel', clearHold);
  boardEl.addEventListener('pointerleave', clearHold);
  boardEl.addEventListener('dblclick', (e)=>{
    const c = pickCellFromEvent(e);
    if (!c) return;
    chord(c);
  });

  function pickCellFromEvent(e){
    const el = e.target.closest('.cell');
    if (!el) return null;
    const x = +el.dataset.x, y = +el.dataset.y;
    return board[y]?.[x] ?? null;
  }

  function onPointerDown(e){
    const c = pickCellFromEvent(e);
    if (!c) return;
    if (e.button === 2){
      toggleFlag(c); return;
    }
    clearHold();
    holdTimer = setTimeout(()=> {
      toggleFlag(c); holdTimer = null;
    }, 350);
    resetBtn.textContent = '😮';
  }
  function onPointerUp(e){
    const c = pickCellFromEvent(e);
    resetBtn.textContent = '🙂';
    if (!c) { clearHold(); return; }
    if (holdTimer){
      clearTimeout(holdTimer); holdTimer = null;
      reveal(c);
    }
  }
  function clearHold(){
    if (holdTimer){ clearTimeout(holdTimer); holdTimer = null; }
  }

  // Keyboard controls
  document.addEventListener('keydown', (e)=>{
    if (ended && (e.key==='r' || e.key==='R')){ reset(); return; }
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)){
      e.preventDefault();
      const {x,y} = indexToXY(focusIndex);
      let nx=x, ny=y;
      if (e.key==='ArrowUp') ny = Math.max(0, y-1);
      if (e.key==='ArrowDown') ny = Math.min(rows-1, y+1);
      if (e.key==='ArrowLeft') nx = Math.max(0, x-1);
      if (e.key==='ArrowRight') nx = Math.min(cols-1, x+1);
      focusIndex = xyToIndex(nx,ny);
      focusCell(nx,ny);
      return;
    }
    if (e.key===' ' || e.key==='Enter'){
      e.preventDefault();
      const {x,y} = indexToXY(focusIndex);
      reveal(board[y][x]); return;
    }
    if (e.key==='f' || e.key==='F'){
      e.preventDefault();
      const {x,y} = indexToXY(focusIndex);
      toggleFlag(board[y][x]); return;
    }
    if (e.key==='c' || e.key==='C'){
      e.preventDefault();
      const {x,y} = indexToXY(focusIndex);
      chord(board[y][x]); return;
    }
    if (e.key==='r' || e.key==='R'){
      e.preventDefault(); reset(); return;
    }
  });

  function xyToIndex(x,y){ return y*cols+x; }
  function indexToXY(i){ return {x: i%cols, y: Math.floor(i/cols)}; }
  function focusCell(x,y){ board[y][x].el.focus(); }

  // Header controls
  $('#newGameBtn').addEventListener('click', ()=> reset());
  $('#fitBtn').addEventListener('click', ()=> autoFitCells(true));
  $('#resetBtn').addEventListener('click', ()=> reset());

  $('#difficulty').addEventListener('change', onDiffChange);
  function onDiffChange(){
    const v = this.value;
    $('#customFields').hidden = (v !== 'custom');
  }

  // Toggles persistence
  $('#soundToggle').checked = localStorage.getItem(LS.SOUND)==='1';
  $('#soundToggle').addEventListener('change', e=> localStorage.setItem(LS.SOUND, e.target.checked?'1':'0'));
  $('#safeFirst').checked = localStorage.getItem(LS.SAFE)!=='0';
  $('#safeFirst').addEventListener('change', e=> localStorage.setItem(LS.SAFE, e.target.checked?'1':'0'));
  $('#showZeros').checked = localStorage.getItem(LS.ZERO)!=='0';
  $('#showZeros').addEventListener('change', e=> localStorage.setItem(LS.ZERO, e.target.checked?'1':'0'));

  // ===== Fitting & Layout =====
  function autoFitCells(manual=false){
    const wrap = document.querySelector('.board-wrap');
    const padding = 24;
    const usable = wrap.clientWidth - padding;
    const size = clamp(Math.floor(usable/cols) - 2, 22, 44);
    document.documentElement.style.setProperty('--cell-size', `${size}px`);
    if (manual){
      boardEl.animate([{transform:'scale(1)'},{transform:'scale(1.02)'},{transform:'scale(1)'}], {duration:250});
    }
  }
  window.addEventListener('resize', ()=> autoFitCells());

  // ===== Best Times =====
  function bestKey(){ return `${cols}x${rows}_${mines}`; }
  function loadBest(){
    try{ return JSON.parse(localStorage.getItem(LS.BEST)||'{}'); }catch{ return {}; }
  }
  function saveBestIfNeeded(){
    const k = bestKey();
    const all = loadBest();
    const prev = all[k];
    if (!prev || elapsed < prev) { all[k] = elapsed; localStorage.setItem(LS.BEST, JSON.stringify(all)); }
    updateBestText();
  }
  function updateBestText(){
    const b = loadBest()[bestKey()];
    $('#bestTimes').textContent = b ? `🏆 Best: ${b}s` : '🏆 Best: —';
  }

  // ===== Difficulty & Reset =====
  function getDesiredParams(){
    const di = $('#difficulty').value;
    if (di === 'custom'){
      const w = clamp(parseInt($('#w').value||9,10), 4, 60);
      const h = clamp(parseInt($('#h').value||9,10), 4, 40);
      const maxM = Math.max(1, w*h - 1);
      const m = clamp(parseInt($('#m').value||10,10), 1, maxM);
      localStorage.setItem(LS.CUSTOM, JSON.stringify({w,h,m}));
      return {w,h,m};
    }
    const p = { beginner:{w:9,h:9,m:10}, intermediate:{w:16,h:16,m:40}, expert:{w:30,h:16,m:99} }[di];
    return {w:p.w, h:p.h, m:p.m};
  }

  function reset(){
    const params = getDesiredParams();
    newGame(params);
    localStorage.setItem(LS.DIFF, $('#difficulty').value);
  }

  (function initDifficulty(){
    const savedDiff = localStorage.getItem(LS.DIFF) || 'beginner';
    $('#difficulty').value = savedDiff;
    if (savedDiff==='custom'){
      const c = JSON.parse(localStorage.getItem(LS.CUSTOM) || '{"w":9,"h":9,"m":10}');
      $('#customFields').hidden = false;
      $('#w').value = c.w; $('#h').value = c.h; $('#m').value = c.m;
    }
  })();

  // Accessibility niceties
  $('#board').addEventListener('focusin', (e)=>{
    const el = e.target.closest('.cell');
    if (!el) return;
    focusIndex = +el.dataset.index;
  });

  // Start
  reset();

})();