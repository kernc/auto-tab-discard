'use strict';

let now = Date.now();

const prefs = {
  'period': 10 * 60, // in seconds
  'audio': true, // audio = true => do not discard if audio is playing
  'pinned': false, // pinned = true => do not discard if tab is pinned
  'online': false, // online = true => do not discard if there is no INTERNET connection
  'form': true, // form = true => do not discard if form data is changed
  'battery': false, // battery = true => only discard if power is disconnected,
  'notification.permission': false,
  'log': false,
  'mode': 'time-based',
  'whitelist': [],
  'whitelist.session': [],
  'whitelist-url': [],
  'memory-enabled': false,
  'memory-value': 60,
  'use-cache': false
};

let allowed = true; // if false, do not discard

chrome.runtime.sendMessage({
  method: 'is-autoDiscardable'
}, b => {
  chrome.runtime.lastError;
  if (typeof b === 'boolean') {
    allowed = b;
  }
});

const log = (...args) => prefs.log && console.log(...args);
const report = message => chrome.runtime.sendMessage({
  method: 'report',
  message
}, () => log(message));
let form = false;

const tools = {};
// return true if tab is not supposed to be discarded
tools.audio = () => {
  if (prefs.audio) {
    return new Promise(resolve => chrome.runtime.sendMessage({
      method: 'is-playing'
    }, r => {
      chrome.runtime.lastError;
      resolve(r);
    }));
  }
  else {
    Promise.resolve(false);
  }
};

tools.pinned = () => {
  if (prefs.pinned === false) {
    return Promise.resolve(false);
  }
  if (prefs['use-cache'] && 'cached' in tools.pinned) {
    return Promise.resolve(tools.pinned.cached);
  }
  return new Promise(resolve => chrome.runtime.sendMessage({
    method: 'is-pinned'
  }, b => {
    chrome.runtime.lastError;
    tools.pinned.cached = b;
    resolve(b);
  }));
};
tools.battery = () => {
  if (prefs.battery === false || navigator.getBattery === undefined) {
    return Promise.resolve(false);
  }
  if (prefs['use-cache'] && 'cached' in tools.battery) {
    return Promise.resolve(tools.battery.cached);
  }
  return new Promise(resolve => navigator.getBattery()
    .then(b => {
      // connected
      tools.battery.cache = b.charging === true || b.chargingTime !== Infinity;
      resolve(tools.battery.cache);
    }));
};
tools.online = () => {
  if (prefs.online === false) {
    return Promise.resolve(false);
  }
  return Promise.resolve(!navigator.onLine);
};
tools.form = () => {
  if (prefs.form === false) {
    return Promise.resolve(false);
  }
  return Promise.resolve(form);
};
tools.whitelist = (list = [...prefs['whitelist'], ...prefs['whitelist.session']]) => {
  const {hostname, href} = document.location;
  const hl = list.filter(s => s.startsWith('re:') === false);
  const rl = list.filter(s => s.startsWith('re:') === true).map(s => s.substr(3));

  if (hl.indexOf(hostname) !== -1) {
    return Promise.resolve(true);
  }
  const b = rl.some(s => {
    try {
      return (new RegExp(s)).test(href);
    }
    catch (e) {
      log('regex error', e);
    }
  });
  return Promise.resolve(b);
};
tools.permission = () => {
  if (prefs['notification.permission'] === false) {
    return Promise.resolve(false);
  }
  return new Promise(resolve => resolve(Notification &&
                                        Notification.permission === 'granted'));
};
tools.urlBased = () => {
  if (prefs.mode === 'url-based') {
    return tools.whitelist(prefs['whitelist-url']).then(a => !a);
  }
  else {
    return Promise.resolve(false);
  }
};
tools.memory = () => {
  if (prefs['memory-enabled'] && window.performance && window.performance.memory) {
    const {totalJSHeapSize} = window.performance.memory;
    return Promise.resolve(totalJSHeapSize > prefs['memory-value'] * 1024 * 1024);
  }
  else {
    return Promise.resolve(false);
  }
};

tools.all = () => Promise.all([
  tools.audio(),
  tools.pinned(),
  tools.battery(),
  tools.online(),
  tools.form(),
  tools.whitelist(),
  tools.permission(),
  tools.urlBased()
]).then(([audio, pinned, battery, online, form, whitelist, permission, urlBased]) => {
  if (audio) {
    report('Tab discard is skipped: Audio is playing');
  }
  if (pinned) {
    report('Tab discard is skipped: Tab is pinned');
  }
  if (battery) {
    report('Tab discard is skipped: Power is plugged-in');
  }
  if (online) {
    report('Tab discard is skipped: No INTERNET connection detected');
  }
  if (form) {
    report('Tab discard is skipped: Unsaved form is detected');
  }
  if (whitelist) {
    report('Tab discard is skipped: Hostname is in the list');
  }
  if (permission) {
    report('Tab discard is skipped: Tab has granted notification.permission');
  }
  if (urlBased) {
    report('Tab discard is skipped: URL does not match with the list');
  }
  if (audio || pinned || battery || online || form || whitelist || permission || urlBased) {
    return true;
  }
});

const timer = {
  id: null,
  time: Infinity,
  set: period => {
    log('set a new timer', prefs.period);
    window.clearTimeout(timer.id);
    timer.time = Date.now() + (period || prefs.period * 1000);
    timer.id = window.setTimeout(timer.discard, period || prefs.period * 1000);
  },
  clear: () => {
    window.clearTimeout(timer.id);
    timer.time = Infinity;
  },
  check: () => {
    log('check timeouts', Date.now() > timer.time);
    if (Date.now() > timer.time) {
      timer.discard();
    }
  }
};

timer.discard = async () => {
  if (allowed === false) {
    return report('Tab discard is skipped: not allowed in this session');
  }
  const r = await tools.all();
  if (r) {
    return log('Tab discard is skipped: one rule matched during double-check before discarding');
  }
  const memory = await tools.memory();
  if (memory) {
    log('force tab discard due to the high memory usage');
    chrome.runtime.sendMessage({
      method: 'simulate',
      cmd: 'discard-tab'
    }, () => chrome.runtime.lastError);
  }
  else {
    log('request tabs.check');
    chrome.runtime.sendMessage({
      method: 'tabs.check'
    }, () => chrome.runtime.lastError);
  }
};

const check = async period => {
  if (document.hidden) {
    if (prefs.period) {
      const r = await tools.all();
      if (r) {
        log('skipped', 'condition match');
        return timer.clear();
      }
      timer.set(period);
    }
    else {
      log('manual mode');
    }
  }
};
document.addEventListener('visibilitychange', () => {
  now = Date.now();
  setTimeout(check, 0);
});
// https://github.com/rNeomy/auto-tab-discard/issues/1
document.addEventListener('DOMContentLoaded', () => check());

chrome.runtime.onMessage.addListener(({method}, sender, response) => {
  if (method === 'introduce') {
    tools.all().then(exception => response({
      exception,
      ready: document.readyState === 'complete' || document.readyState === 'loaded',
      now,
      allowed
    }));
    return true;
  }
});

// messages
let aID;
window.addEventListener('message', e => {
  if (e.data && e.data.cmd === 'ntd-command') {
    e.preventDefault();
    if (e.data.form) {
      form = e.data.form;
    }
    if ('audio' in e.data) { // check when media status is changed
      window.clearTimeout(aID);
      aID = window.setTimeout(() => check(), e.data.audio ? 0 : 5000);
    }
  }
});

// prefs
const storage = prefs => new Promise(resolve => {
  chrome.storage.managed.get(prefs, ps => {
    chrome.storage.local.get(chrome.runtime.lastError ? prefs : ps || prefs, resolve);
  });
});
storage(prefs).then(ps => {
  Object.assign(prefs, ps);
  // for already loaded tabs
  if (document.readyState === 'complete' || document.readyState === 'loaded') {
    if (document.hidden) {
      check();
    }
  }
});

chrome.storage.onChanged.addListener(ps => {
  Object.keys(ps).forEach(k => prefs[k] = ps[k].newValue);
  if (ps.period || ps.mode) {
    check();
  }
});
