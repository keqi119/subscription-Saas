/* Local browser bridge: renders the official compiler's virtual tree.
 * It deliberately does not implement WeChat networking, auth, payment or signing.
 */
(() => {
  'use strict';
  const source = window.__preview;
  const appConfig = source.configs['app.json'];
  const template = source.wxml({});
  const stylesheet = source.wxss({});
  const cache = {};
  const definitions = {};
  const components = new Map();
  let registration;
  let app;
  let current;
  let history = [];
  let renderQueued = false;
  let nodeNumber = 0;
  const pageRoot = document.getElementById('preview-page');
  const tabs = document.getElementById('preview-tabs');
  const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

  function report(error) {
    console.error(error);
    const message = document.createElement('pre');
    message.className = 'preview-runtime-error';
    message.textContent = '源码预览运行错误：\n' + (error.stack || error.message || error);
    pageRoot.replaceChildren(message);
  }
  window.addEventListener('error', (event) => report(event.error || event.message));
  window.addEventListener('unhandledrejection', (event) => report(event.reason));

  function toast(options) {
    const element = document.getElementById('preview-toast');
    element.textContent = options.title;
    element.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
      element.hidden = true;
    }, options.duration || 2500);
    options.success?.({ errMsg: 'showToast:ok' });
  }
  const wx = {
    getStorageSync(key) {
      const value = localStorage.getItem('mp-source-preview:' + key);
      return value === null ? '' : JSON.parse(value);
    },
    setStorageSync(key, value) {
      localStorage.setItem('mp-source-preview:' + key, JSON.stringify(value));
    },
    removeStorageSync(key) {
      localStorage.removeItem('mp-source-preview:' + key);
    },
    navigateTo(options) {
      navigate(options.url, false, options);
    },
    redirectTo(options) {
      navigate(options.url, 'replace', options);
    },
    switchTab(options) {
      navigate(options.url, true, options);
    },
    reLaunch(options) {
      navigate(options.url, true, options);
    },
    navigateBack(options = {}) {
      if (history.length > 1) {
        current?.onHide?.();
        const removed = history.splice(-Math.min(options.delta || 1, history.length - 1));
        removed.forEach((page) => page.onUnload?.());
        show(history.at(-1));
      }
      options.success?.({});
    },
    setNavigationBarTitle(options) {
      if (current) current.previewTitle = options.title;
      document.getElementById('preview-title').textContent = options.title;
    },
    showToast: toast,
    showLoading(options) {
      toast({ title: options.title || '加载中…', duration: 60000 });
    },
    hideLoading() {
      document.getElementById('preview-toast').hidden = true;
    },
    showModal(options) {
      const confirm = window.confirm(options.title + '\n\n' + (options.content || ''));
      options.success?.({ confirm, cancel: !confirm });
    },
    chooseMedia(options) {
      toast({ title: '已添加本地示例附件元数据；未读取或上传文件' });
      options.success?.({
        tempFiles: [
          {
            tempFilePath: 'preview://sample-image',
            size: 1024,
            fileType: 'image',
            width: 800,
            height: 600,
          },
        ],
      });
    },
    previewImage(options) {
      const urls = (options.urls || []).filter((url) => String(url).startsWith('/assets/'));
      if (!urls.length)
        return options.fail?.({
          errMsg: 'previewImage:fail only bundled local images are supported',
        });
      const dialog = document.createElement('dialog');
      dialog.style.cssText = 'max-width:95vw;padding:16px;background:#f4f3ef;border:1px solid #bbb';
      const close = document.createElement('button');
      close.textContent = '关闭图片';
      close.onclick = () => {
        dialog.close();
        dialog.remove();
      };
      dialog.append(close);
      urls.forEach((url) => {
        const image = document.createElement('img');
        image.src = url;
        image.alt = '本地示例资料';
        image.style.cssText = 'display:block;max-width:100%;margin-top:12px';
        dialog.append(image);
      });
      document.body.append(dialog);
      dialog.showModal();
      options.success?.({});
    },
    request(options) {
      const error = { errMsg: 'request:fail source preview blocks network requests' };
      options.fail?.(error);
      options.complete?.(error);
      return { abort() {} };
    },
    uploadFile(options) {
      options.fail?.({ errMsg: 'uploadFile:fail source preview blocks uploads' });
      return { abort() {} };
    },
    stopPullDownRefresh() {},
    getSystemInfoSync() {
      return {
        platform: 'devtools',
        windowWidth: innerWidth,
        windowHeight: innerHeight,
        pixelRatio: devicePixelRatio,
        safeArea: { top: 0, bottom: innerHeight },
      };
    },
  };
  function resolve(request, parent = '') {
    const parts = request.startsWith('.')
      ? parent.split('/').slice(0, -1).concat(request.split('/'))
      : request.replace(/^\//, '').split('/');
    const normalized = [];
    for (const part of parts) {
      if (part === '..') normalized.pop();
      else if (part && part !== '.') normalized.push(part);
    }
    const base = normalized.join('/');
    for (const file of [base, base + '.js', base + '.json', base + '/index.js'])
      if (source.modules[file] || source.configs[file]) return file;
    throw new Error('Unsupported or missing CommonJS module: ' + request + ' from ' + parent);
  }
  function requireModule(request, parent) {
    const file = resolve(request, parent);
    if (source.configs[file]) return source.configs[file];
    if (cache[file]) return cache[file].exports;
    const module = { exports: {} };
    cache[file] = module;
    const previous = registration;
    registration = file;
    source.modules[file](
      (name) => requireModule(name, file),
      module,
      module.exports,
      wx,
      (definition) => {
        definitions[registration] = definition;
      },
      (definition) => {
        definitions[registration] = definition;
      },
      (definition) => {
        app = definition;
      },
      () => app,
      () => history,
    );
    registration = previous;
    // This browser review surface is intentionally pinned to local Mock mode.
    if (file === 'config.js')
      module.exports = Object.freeze({ ...module.exports, mode: 'mock', apiBase: '' });
    return module.exports;
  }
  function instance(route, component = false) {
    requireModule(route + '.js');
    const definition = definitions[route + '.js'];
    if (!definition) throw new Error('No Page/Component registration: ' + route);
    const value = {
      ...definition,
      ...(definition.methods || {}),
      route,
      data: clone(definition.data || {}),
    };
    value.setData = (patch, callback) => {
      for (const [key, entry] of Object.entries(patch)) {
        const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.');
        let target = value.data;
        parts.slice(0, -1).forEach((part, index) => {
          target = target[part] ||= /^\d+$/.test(parts[index + 1]) ? [] : {};
        });
        target[parts.at(-1)] = entry;
      }
      if (!renderQueued) {
        renderQueued = true;
        queueMicrotask(() => {
          renderQueued = false;
          try {
            render();
            callback?.();
          } catch (error) {
            report(error);
          }
        });
      }
    };
    if (component) {
      value.lifetimes?.attached?.call(value);
      value.pageLifetimes?.show?.call(value);
    }
    return value;
  }
  function applyStyles(route) {
    document.querySelectorAll('style[data-preview-compiled]').forEach((style) => style.remove());
    const paths = [
      'app.wxss',
      route + '.wxss',
      ...Object.values(appConfig.usingComponents || {}).map(
        (value) => value.replace(/^\//, '') + '.wxss',
      ),
    ];
    for (const file of paths) {
      const before = new Set(document.querySelectorAll('style'));
      const generate = stylesheet(file);
      if (generate) generate('', { deviceWidth: innerWidth, allowIllegalSelector: true });
      document.querySelectorAll('style').forEach((style) => {
        if (!before.has(style)) style.dataset.previewCompiled = 'true';
      });
    }
  }
  function show(page) {
    current = page;
    components.clear();
    document.getElementById('preview-title').textContent =
      page.previewTitle ||
      source.configs[page.route + '.json']?.navigationBarTitleText ||
      appConfig.window.navigationBarTitleText;
    document.getElementById('preview-back').hidden = history.length < 2;
    applyStyles(page.route);
    render();
    page.onShow?.();
    if (!page.previewReady) {
      page.previewReady = true;
      queueMicrotask(() => page.onReady?.());
    }
    scrollTo(0, 0);
    window.location.hash = '/' + page.route + (page.queryString ? '?' + page.queryString : '');
  }
  function navigate(url, replace, options = {}) {
    const parsed = new URL(url, 'http://preview.local');
    const route = parsed.pathname.replace(/^\//, '');
    if (!appConfig.pages.includes(route)) {
      options.fail?.({ errMsg: 'Unknown page route' });
      return toast({ title: '未注册的页面：' + route });
    }
    current?.onHide?.();
    if (replace === true) {
      history.forEach((page) => page.onUnload?.());
      history = [];
    } else if (replace === 'replace') history.pop()?.onUnload?.();
    const page = instance(route);
    page.options = Object.fromEntries(parsed.searchParams);
    page.queryString = parsed.searchParams.toString();
    history.push(page);
    current = page;
    page.onLoad?.(page.options);
    show(page);
    options.success?.({ errMsg: 'navigateTo:ok' });
  }
  function callHandler(owner, name, element, event, detail = {}) {
    if (typeof owner[name] !== 'function')
      throw new Error('Missing event handler ' + name + ' on ' + owner.route);
    const result = owner[name]({
      type: event.type,
      detail,
      currentTarget: { dataset: { ...element.dataset }, id: element.id },
      target: { dataset: { ...event.target.dataset }, id: event.target.id },
    });
    if (result?.catch) result.catch(report);
  }
  function node(tree, owner) {
    if (tree === null || tree === undefined) return document.createTextNode('');
    if (typeof tree !== 'object') return document.createTextNode(String(tree));
    if (tree.tag === 'virtual' || !tree.tag) {
      const fragment = document.createDocumentFragment();
      (tree.children || []).forEach((child) => fragment.append(node(child, owner)));
      return fragment;
    }
    const tag = tree.tag.replace(/^wx-/, '');
    const componentPath = {
      ...(appConfig.usingComponents || {}),
      ...(source.configs[owner.route + '.json']?.usingComponents || {}),
    }[tag];
    if (componentPath) {
      const route = componentPath.startsWith('/')
        ? componentPath.slice(1)
        : resolve(componentPath, owner.route + '.js').replace(/\.js$/, '');
      const key = owner.route + ':' + tag + ':' + nodeNumber++;
      if (!components.has(key)) components.set(key, instance(route, true));
      const child = components.get(key);
      const wrapper = document.createElement(tree.tag);
      wrapper.append(node(template(route + '.wxml')(child.data), child));
      return wrapper;
    }
    const element = document.createElement(tag === 'br' ? 'br' : tree.tag);
    const attrs = tree.attr || {};
    element.dataset.previewNode = String(nodeNumber++);
    for (const [key, value] of Object.entries(attrs)) {
      if (
        /^(bind|catch)/.test(key) ||
        ['value', 'range', 'rangeKey', 'checked'].includes(key) ||
        value === undefined ||
        value === null
      )
        continue;
      const name = key.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase());
      if (['disabled', 'hidden'].includes(name)) {
        if (value) element.setAttribute(name, '');
      } else element.setAttribute(name, String(value));
    }
    if (tag === 'image') {
      const image = document.createElement('img');
      const url = String(attrs.src || '');
      if (url.startsWith('/assets/')) image.src = url;
      image.alt = attrs.ariaLabel || '';
      image.style.objectFit = attrs.mode === 'aspectFill' ? 'cover' : 'contain';
      element.append(image);
    } else if (tag === 'input' || tag === 'textarea') {
      const input = document.createElement(tag === 'input' ? 'input' : 'textarea');
      input.dataset.previewInput = element.dataset.previewNode;
      input.value = attrs.value ?? '';
      input.placeholder = attrs.placeholder || '';
      input.disabled = Boolean(attrs.disabled);
      if (attrs.maxlength !== undefined) input.maxLength = Number(attrs.maxlength);
      if (tag === 'input') {
        input.type = attrs.password
          ? 'password'
          : attrs.type === 'number' || attrs.type === 'digit'
            ? 'text'
            : attrs.type || 'text';
        if (['number', 'digit'].includes(attrs.type))
          input.inputMode = attrs.type === 'digit' ? 'decimal' : 'numeric';
      }
      input.setAttribute('aria-label', attrs.ariaLabel || attrs.placeholder || '输入');
      element.append(input);
    } else if (tag === 'checkbox' || tag === 'radio') {
      const input = document.createElement('input');
      input.type = tag;
      input.value = attrs.value || '';
      input.checked = Boolean(attrs.checked);
      input.disabled = Boolean(attrs.disabled);
      input.setAttribute('aria-label', attrs.ariaLabel || attrs.value || '同意');
      element.append(input);
    } else (tree.children || []).forEach((child) => element.append(node(child, owner)));
    if (tag === 'label')
      element.addEventListener('click', (event) => {
        if (event.target.tagName !== 'INPUT') element.querySelector('input')?.click();
      });
    if (tag === 'button' || attrs.bindtap || attrs.catchtap) {
      element.tabIndex = attrs.disabled ? -1 : 0;
      if (tag === 'button') element.setAttribute('role', 'button');
      element.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          element.click();
        }
      });
    }
    for (const [key, handler] of Object.entries(attrs)) {
      const match = /^(bind|catch):?(tap|input|change|confirm|blur|focus|submit)$/.exec(key);
      if (!match) continue;
      const eventType =
        { tap: 'click', confirm: 'keydown', submit: 'submit' }[match[2]] || match[2];
      element.addEventListener(eventType, (event) => {
        if (attrs.disabled || (match[2] === 'confirm' && event.key !== 'Enter')) return;
        if (match[1] === 'catch') event.stopPropagation();
        let detail = { value: event.target.value };
        if (tag === 'checkbox-group')
          detail.value = [...element.querySelectorAll('input:checked')].map((input) => input.value);
        if (tag === 'radio-group')
          detail.value = element.querySelector('input:checked')?.value || '';
        if (tag === 'picker') return;
        callHandler(owner, handler, element, event, detail);
      });
    }
    if (tag === 'picker') {
      element.tabIndex = 0;
      element.addEventListener('click', (event) => {
        if (attrs.disabled) return;
        let value;
        if (attrs.mode === 'date' || attrs.mode === 'time')
          value = window.prompt(
            attrs.mode === 'date' ? '选择日期 YYYY-MM-DD' : '选择时间 HH:MM',
            attrs.value || '',
          );
        else {
          const range = attrs.range || [];
          const answer = window.prompt(
            range
              .map((item, index) => `${index + 1}. ${attrs.rangeKey ? item[attrs.rangeKey] : item}`)
              .join('\n'),
            String(Number(attrs.value || 0) + 1),
          );
          if (answer === null) return;
          value = Number(answer) - 1;
          if (!Number.isInteger(value) || value < 0 || value >= range.length) return;
        }
        if (value !== null && attrs.bindchange)
          callHandler(owner, attrs.bindchange, element, event, { value });
      });
    }
    return element;
  }
  function render() {
    if (!current) return;
    const active = document.activeElement;
    const focused = active?.dataset.previewInput;
    const selection = focused ? [active.selectionStart, active.selectionEnd] : null;
    nodeNumber = 0;
    const tree = template(current.route + '.wxml')(current.data);
    pageRoot.replaceChildren(node(tree, current));
    if (focused) {
      const input = pageRoot.querySelector(`[data-preview-input="${focused}"]`);
      input?.focus({ preventScroll: true });
      if (input && selection && input.setSelectionRange) input.setSelectionRange(...selection);
    }
    const isTab = appConfig.tabBar.list.some((tab) => tab.pagePath === current.route);
    tabs.hidden = !isTab;
    pageRoot.style.paddingBottom = isTab ? '66px' : '0';
    tabs.replaceChildren(
      ...appConfig.tabBar.list.map((tab) => {
        const button = document.createElement('button');
        const selected = tab.pagePath === current.route;
        if (selected) button.setAttribute('aria-current', 'page');
        const image = document.createElement('img');
        image.src = '/' + (selected ? tab.selectedIconPath : tab.iconPath);
        image.alt = '';
        const label = document.createElement('span');
        label.textContent = tab.text;
        button.append(image, label);
        button.addEventListener('click', () => navigate('/' + tab.pagePath, true));
        return button;
      }),
    );
  }
  document.getElementById('preview-back').addEventListener('click', () => wx.navigateBack());
  document
    .getElementById('preview-refresh')
    .addEventListener('click', () =>
      navigate(
        '/' + current.route + (current.queryString ? '?' + current.queryString : ''),
        'replace',
      ),
    );
  try {
    requireModule('app.js');
    app?.onLaunch?.();
    navigate(window.location.hash.slice(1) || '/' + appConfig.pages[0], true);
  } catch (error) {
    report(error);
  }
})();
