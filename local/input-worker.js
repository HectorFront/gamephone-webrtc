const { parentPort } = require('worker_threads');
const { mouse, keyboard, Key, Button, Point } = require('@nut-tree-fork/nut-js');
const { spawn } = require('child_process');
const path = require('path');

mouse.config.mouseSpeed = 9999;
keyboard.config.autoDelayMs = 0;

// PowerShell persistente com SendInput relativo (Raw Input — lido pelo GTA)
const _ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'mouse-input.ps1')], { stdio: ['pipe','ignore','ignore'] });

const _sendInputRelative = (dx, dy) => {
  const x = Math.round(dx), y = Math.round(dy);
  if (x === 0 && y === 0) return;
  _ps.stdin.write(x + ',' + y + '\n');
};
console.log('[input-worker] SendInput relativo ativo (PowerShell persistente)');

const KEY_MAP = {
  a:'A', b:'B', c:'C', d:'D', e:'E', f:'F', g:'G', h:'H', i:'I', j:'J',
  k:'K', l:'L', m:'M', n:'N', o:'O', p:'P', q:'Q', r:'R', s:'S', t:'T',
  u:'U', v:'V', w:'W', x:'X', y:'Y', z:'Z',
  space:'Space', return:'Return', escape:'Escape', tab:'Tab',
  backspace:'Backspace', delete:'Delete',
  up:'Up', down:'Down', left:'Left', right:'Right',
  caps_lock:'CapsLock',
  f1:'F1', f2:'F2', f3:'F3', f4:'F4', f5:'F5',
  f6:'F6', f7:'F7', f8:'F8', f9:'F9', f10:'F10', f11:'F11', f12:'F12',
  super:'LeftSuper', ctrl:'LeftControl', alt:'LeftAlt', shift:'LeftShift',
};

function getKey(k) { return Key[KEY_MAP[k?.toLowerCase()] ?? k]; }

let _screenW = 2560, _screenH = 1440;

parentPort.on('message', async (cmd) => {
  try {
    const { action } = cmd;
    if (action === 'init') { _screenW = cmd.w; _screenH = cmd.h; return; }
    if (action === 'reset') { return; }

    if (action === 'mousemove') {
      _sendInputRelative(cmd.dx || 0, cmd.dy || 0);
    }
    else if (action === 'scroll') {
      const dy = cmd.dy || 0, dx = cmd.dx || 0;
      if (dy > 0) await mouse.scrollDown(Math.max(1, Math.round(dy * 3)));
      else if (dy < 0) await mouse.scrollUp(Math.max(1, Math.round(-dy * 3)));
      if (dx > 0) await mouse.scrollRight(Math.max(1, Math.round(dx * 3)));
      else if (dx < 0) await mouse.scrollLeft(Math.max(1, Math.round(-dx * 3)));
    }
    else if (action === 'mouseabs')  await mouse.setPosition(new Point(cmd.x, cmd.y));
    else if (action === 'click')     await mouse.click(cmd.button === 'right' ? Button.RIGHT : Button.LEFT);
    else if (action === 'mousedown') await mouse.pressButton(cmd.button === 'right' ? Button.RIGHT : Button.LEFT);
    else if (action === 'mouseup')   await mouse.releaseButton(cmd.button === 'right' ? Button.RIGHT : Button.LEFT);
    else if (action === 'keydown')   { const k = getKey(cmd.key); if (k !== undefined) await keyboard.pressKey(k); }
    else if (action === 'keyup')     { const k = getKey(cmd.key); if (k !== undefined) await keyboard.releaseKey(k); }
    else if (action === 'keypress')  { const k = getKey(cmd.key); if (k !== undefined) await keyboard.type(k); }
    else if (action === 'type')      await keyboard.type(cmd.text);
  } catch(e) {
    console.error('[worker]', e.message);
  }
});
