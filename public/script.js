document.addEventListener('DOMContentLoaded', () => {
  const socket = window.io ? io() : createOfflineSocket();
  const terminalHost = document.getElementById('terminal');
  const trafficMapDashboard = window.createTrafficMapDashboard?.(socket);

  // Preload traffic map in the background
  if (trafficMapDashboard) {
    trafficMapDashboard.load();
    window.trafficMapInitialLoaded = true;
  }

  function createOfflineSocket() {
    return {
      emit() {},
      on(eventName, handler) {
        if (eventName === 'connect_error') {
          setTimeout(() => handler(new Error('Socket client unavailable')), 0);
        }
      }
    };
  }
  
  // Terminal Setup
  const term = createTerminal(terminalHost);

  function createTerminal(host) {
    if (window.Terminal && window.FitAddon) {
      host.classList.add('has-xterm');
      const xterm = new Terminal({
        theme: {
          background: '#00000000',
          foreground: '#d8e7ff',
          cursor: '#ff9e42',
          cursorAccent: '#0b1224',
          selectionBackground: 'rgba(255, 158, 66, 0.28)',
          black: '#102034',
          brightBlack: '#637693',
          red: '#ff7a70',
          brightRed: '#ffb4ad',
          green: '#51d89b',
          brightGreen: '#8cf0c0',
          yellow: '#ffd166',
          brightYellow: '#ffe199',
          blue: '#7db6ff',
          brightBlue: '#b6d6ff',
          magenta: '#d8b4fe',
          brightMagenta: '#ead6ff',
          cyan: '#67e8f9',
          brightCyan: '#a5f3fc',
          white: '#e8f1ff',
          brightWhite: '#ffffff'
        },
        fontFamily: '"SF Mono", "Cascadia Code", Consolas, monospace',
        fontWeight: 600,
        fontWeightBold: 800,
        fontSize: 13,
        lineHeight: 1.42,
        convertEol: true,
        allowTransparency: true
      });

      const fitAddon = new FitAddon.FitAddon();
      xterm.loadAddon(fitAddon);
      xterm.open(host);

      const observer = new ResizeObserver(() => {
        fitAddon.fit();
      });
      observer.observe(host);

      setTimeout(() => {
        fitAddon.fit();
        xterm.writeln('Welcome to Cloudflare Zerotrust Gateway Scripts');
        xterm.writeln('Waiting for commands...\n');
      }, 100);

      return xterm;
    }

    const fallbackOutput = document.createElement('pre');
    host.classList.add('has-fallback');
    fallbackOutput.className = 'fallback-terminal';
    host.appendChild(fallbackOutput);

    const stripAnsi = (value) => String(value).replace(/\x1B\[[0-9;]*m/g, '');
    const scrollToEnd = () => {
      host.scrollTop = host.scrollHeight;
    };

    const fallback = {
      write(data) {
        fallbackOutput.textContent += stripAnsi(data);
        scrollToEnd();
      },
      writeln(data = '') {
        this.write(`${data}\n`);
      },
      clear() {
        fallbackOutput.textContent = '';
      }
    };

    fallback.writeln('Welcome to Cloudflare Zerotrust Gateway Scripts');
    fallback.writeln('Waiting for commands...\n');
    return fallback;
  }

  // Socket Connection Status
  const statusIndicator = document.getElementById('connection-status');
  socket.on('connect', () => {
    statusIndicator.textContent = 'Connected';
    statusIndicator.classList.add('connected');
    statusIndicator.style.color = '';
    emitDashboardViewState();
  });
  socket.on('disconnect', () => {
    statusIndicator.textContent = 'Disconnected';
    statusIndicator.classList.remove('connected');
    statusIndicator.style.color = '';
  });
  socket.on('connect_error', (err) => {
    console.error("Socket connection error:", err);
    statusIndicator.textContent = 'Connection Error';
    statusIndicator.classList.remove('connected');
    statusIndicator.style.color = 'var(--danger)';
  });

  // Socket Logs
  socket.on('log', (data) => {
    console.log("Terminal log:", data);
    term.write(data);
  });

  // Script Progress Events
  const progressElements = {
    update: {
      container: document.getElementById('update-progress'),
      phase: document.getElementById('progress-phase'),
      fraction: document.getElementById('progress-fraction'),
      bar: document.getElementById('progress-bar'),
    },
    defragment: {
      container: document.getElementById('defragment-progress'),
      phase: document.getElementById('defragment-progress-phase'),
      fraction: document.getElementById('defragment-progress-fraction'),
      bar: document.getElementById('defragment-progress-bar'),
    },
    'full-reset': {
      container: document.getElementById('full-reset-progress'),
      phase: document.getElementById('full-reset-progress-phase'),
      fraction: document.getElementById('full-reset-progress-fraction'),
      bar: document.getElementById('full-reset-progress-bar'),
    },
  };

  function updateProgress(data) {
    const operation = data.operation || 'update';
    const progress = progressElements[operation] || progressElements.update;
    if (!progress?.container || !progress.phase || !progress.fraction || !progress.bar) return;

    progress.container.style.display = 'block';

    const phase = data.phase || 'progress';
    const phaseDisplay = phase.charAt(0).toUpperCase() + phase.slice(1);
    progress.phase.textContent = data.message || `${phaseDisplay}...`;
    progress.fraction.textContent = `${data.current}/${data.total}`;

    const percent = data.total > 0 ? (data.current / data.total) * 100 : 0;
    progress.bar.style.width = `${Math.min(percent, 100)}%`;
  }

  function resetProgress(operation, message = 'Starting...') {
    const progress = progressElements[operation];
    if (!progress?.container || !progress.phase || !progress.fraction || !progress.bar) return;
    progress.phase.textContent = message;
    progress.fraction.textContent = '0/0';
    progress.bar.style.width = '0%';
    progress.container.style.display = 'block';
  }

  function hideProgress(operation) {
    const progress = progressElements[operation];
    if (progress?.container) {
      progress.container.style.display = 'none';
    }
  }

  socket.on('script_progress', (data) => {
    console.log("Script progress:", data);
    updateProgress(data);
  });

  document.getElementById('btn-clear-term').addEventListener('click', () => {
    term.clear();
  });

  // Navigation Logic
  const navBtns = document.querySelectorAll('.nav-btn');
  const sections = document.querySelectorAll('.section');
  const contentSections = document.querySelector('.content-sections');
  const currentViewLabel = document.getElementById('current-view-label');
  let activeDashboardTab = document.querySelector('.nav-btn.active')?.dataset.target || 'dns-analytics';
  function emitDashboardViewState(extra = {}) {
    socket.emit('dashboard_view_state', {
      activeTab: activeDashboardTab,
      ...extra,
    });
  }
  const mobileLayoutQuery = window.matchMedia('(max-width: 980px)');
  const updateContentOverflow = () => {
    if (!contentSections) return;
    if (mobileLayoutQuery.matches) {
      contentSections.classList.remove('is-overflowing');
      return;
    }

    const isOverflowing = contentSections.scrollHeight > contentSections.clientHeight + 1;
    contentSections.classList.toggle('is-overflowing', isOverflowing);
  };
  const scheduleContentOverflowCheck = () => {
    requestAnimationFrame(() => {
      requestAnimationFrame(updateContentOverflow);
    });
  };

  if (window.ResizeObserver && contentSections) {
    const contentResizeObserver = new ResizeObserver(scheduleContentOverflowCheck);
    contentResizeObserver.observe(contentSections);
    sections.forEach(section => contentResizeObserver.observe(section));
  }

  if (window.MutationObserver && contentSections) {
    const contentMutationObserver = new MutationObserver(scheduleContentOverflowCheck);
    contentMutationObserver.observe(contentSections, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true
    });
  }

  window.addEventListener('resize', scheduleContentOverflowCheck);
  mobileLayoutQuery.addEventListener?.('change', scheduleContentOverflowCheck);
  scheduleContentOverflowCheck();

  // Terminal container for show/hide logic
  const terminalContainer = document.querySelector('.terminal-container');

  // Hide terminal on initial load if DNS Analytics is the active section
  if (terminalContainer && document.getElementById('section-dns-analytics')?.classList.contains('active')) {
    terminalContainer.style.display = 'none';
  }

  navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      const currentActive = document.querySelector('.section.visible');
      const nextSection = document.getElementById(`section-${targetId}`);

      if (currentActive === nextSection) return;
      activeDashboardTab = targetId;
      emitDashboardViewState({ activeTab: targetId });

      // Update active nav immediately
      navBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentViewLabel.textContent = btn.dataset.label || btn.textContent.trim();

      // Hide current section
      if (currentActive) {
        currentActive.classList.remove('active');
        currentActive.classList.remove('visible');
      }
      scheduleContentOverflowCheck();

      // Show/hide terminal based on section
      if (targetId === 'dns-analytics' || targetId === 'traffic-map') {
        if (terminalContainer) terminalContainer.style.display = 'none';
      } else {
        if (terminalContainer) terminalContainer.style.display = '';
      }

      // Step 1: make next section display:block (visible class)
      // Step 2: on next frame add active to trigger CSS transition
      nextSection.classList.add('visible');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          nextSection.classList.add('active');
          scheduleContentOverflowCheck();

          if (targetId === 'manage-urls') {
            loadUrls();
          } else if (targetId === 'update-ipv4-location') {
            loadIpv4Location();
          } else if (targetId === 'manage-rewrites') {
            loadDnsRewrites();
          } else if (targetId === 'manage-allowlist') {
            loadAllowlist();
          } else if (targetId === 'manage-denylist') {
            loadDenylist();
          } else if (targetId === 'traffic-map') {
            if (!window.trafficMapInitialLoaded) {
              trafficMapDashboard?.load();
              window.trafficMapInitialLoaded = true;
            }
          }
        });
      });
    });
  });

  // --- Dashboard Actions ---
  const btnRunUpdate = document.getElementById('btn-run-update');
  btnRunUpdate.addEventListener('click', () => {
    btnRunUpdate.disabled = true;
    term.writeln('\n\x1b[36m--- Starting Update ---\x1b[0m\n');
    resetProgress('update');
    socket.emit('run_update');
  });

  const btnDefragment = document.getElementById('btn-run-defragment');
  btnDefragment.addEventListener('click', () => {
    if (confirm('Defragment will optimize your CZGS lists by consolidating entries and deleting empty lists. Continue?')) {
      btnDefragment.disabled = true;
      term.writeln('\n\x1b[36m--- Starting Defragment ---\x1b[0m\n');
      resetProgress('defragment', 'Starting defragment...');
      socket.emit('run_defragment');
    }
  });

  const btnFullReset = document.getElementById('btn-run-full-reset');
  btnFullReset.addEventListener('click', () => {
    if (confirm('Are you SURE you want to do a full reset? This will DELETE generated CZGS block lists and block rules, but will preserve the custom allowlist/denylist and their custom rules.')) {
      btnFullReset.disabled = true;
      term.writeln('\n\x1b[31m--- Starting Full Reset ---\x1b[0m\n');
      resetProgress('full-reset', 'Starting full reset...');
      socket.emit('full_reset');
    }
  });

  socket.on('update_complete', ({ operation = 'update' } = {}) => {
    btnRunUpdate.disabled = false;
    btnDefragment.disabled = false;
    btnFullReset.disabled = false;
    term.writeln('\n\x1b[32m=== All tasks completed ===\x1b[0m\n');
    if (operation === 'update') {
      hideProgress('update');
    }
  });

  // --- IPv4 Location Actions ---
  const ipv4LocationName = document.getElementById('ipv4-location-name');
  const ipv4CurrentNetwork = document.getElementById('ipv4-current-network');
  const ipv4LocationLoader = document.getElementById('ipv4-location-loader');
  const ipv4LocationInput = document.getElementById('ipv4-location-input');
  const ipv4LocationStatus = document.getElementById('ipv4-location-status');
  const btnUpdateIpv4Location = document.getElementById('btn-update-ipv4-location');
  const endpointIpv4 = document.getElementById('endpoint-ipv4');
  const endpointIpv6 = document.getElementById('endpoint-ipv6');
  const endpointDot = document.getElementById('endpoint-dot');
  const endpointDoh = document.getElementById('endpoint-doh');
  let loadedIpv4Network = '';

  function isValidIpv4(value) {
    const parts = String(value || '').trim().split('.');
    return parts.length === 4 && parts.every(part => {
      if (!/^\d{1,3}$/.test(part)) return false;
      if (part.length > 1 && part.startsWith('0')) return false;
      const numeric = Number(part);
      return numeric >= 0 && numeric <= 255;
    });
  }

  function setIpv4LocationStatus(message, type = '') {
    ipv4LocationStatus.textContent = message;
    ipv4LocationStatus.className = type ? `status-msg ${type}` : 'status-msg';
  }

  function setIpv4LocationLoading(isLoading) {
    ipv4LocationLoader.style.display = isLoading ? 'block' : 'none';
    btnUpdateIpv4Location.disabled = isLoading;
  }

  function endpointValue(endpoint) {
    if (!endpoint || endpoint.enabled === false || !endpoint.value) return 'Unavailable';
    return endpoint.value;
  }

  function renderDnsEndpoints(dnsEndpoints = {}) {
    endpointIpv4.textContent = endpointValue(dnsEndpoints.ipv4);
    endpointIpv6.textContent = endpointValue(dnsEndpoints.ipv6);
    endpointDot.textContent = endpointValue(dnsEndpoints.dot);
    endpointDoh.textContent = endpointValue(dnsEndpoints.doh);
  }

  function renderGatewayLocationData({ locationName, protectedNetwork, network, dnsEndpoints, updatedAt }) {
    const currentNetwork = protectedNetwork || network || '';
    loadedIpv4Network = currentNetwork;
    ipv4LocationName.textContent = locationName || 'Cloudflare location';
    ipv4CurrentNetwork.textContent = currentNetwork || 'No protected source IPv4 configured';
    ipv4LocationInput.value = currentNetwork ? currentNetwork.replace(/\/32$/, '') : '';
    renderDnsEndpoints(dnsEndpoints);
    setIpv4LocationStatus(updatedAt ? `Loaded from Cloudflare. Updated ${new Date(updatedAt).toLocaleString()}.` : 'Loaded from Cloudflare.', 'success');
  }

  function loadIpv4Location() {
    setIpv4LocationLoading(true);
    setIpv4LocationStatus('Loading current Cloudflare location...');
    ipv4LocationName.textContent = 'Loading...';
    ipv4CurrentNetwork.textContent = 'Loading...';
    renderDnsEndpoints({
      ipv4: { value: 'Loading...', enabled: true },
      ipv6: { value: 'Loading...', enabled: true },
      dot: { value: 'Loading...', enabled: true },
      doh: { value: 'Loading...', enabled: true },
    });
    socket.emit('get_gateway_location_ipv4');
  }

  btnUpdateIpv4Location.addEventListener('click', () => {
    const ipv4 = ipv4LocationInput.value.trim();
    if (!isValidIpv4(ipv4)) {
      setIpv4LocationStatus('Enter a valid IPv4 address.', 'error');
      return;
    }

    const newNetwork = `${ipv4}/32`;
    if (loadedIpv4Network === newNetwork) {
      setIpv4LocationStatus('This IPv4 is already protected.', 'success');
      return;
    }

    btnUpdateIpv4Location.disabled = true;
    setIpv4LocationStatus('Updating Cloudflare location...');
    term.writeln('\n\x1b[36m--- Updating Cloudflare IPv4 location ---\x1b[0m\n');
    socket.emit('update_gateway_location_ipv4', { ipv4 });
  });

  socket.on('gateway_location_ipv4_data', (data) => {
    setIpv4LocationLoading(false);
    renderGatewayLocationData(data);
  });

  socket.on('gateway_location_ipv4_error', ({ error }) => {
    setIpv4LocationLoading(false);
    setIpv4LocationStatus(`Error: ${error}`, 'error');
    ipv4LocationName.textContent = 'Unable to load';
    ipv4CurrentNetwork.textContent = 'Unavailable';
    renderDnsEndpoints();
  });

  socket.on('gateway_location_ipv4_updated', (data) => {
    btnUpdateIpv4Location.disabled = false;
    if (!data.success) {
      setIpv4LocationStatus(`Error: ${data.error}`, 'error');
      return;
    }

    renderGatewayLocationData(data);
    setIpv4LocationStatus(data.updatedAt ? `Updated successfully. Cloudflare updated ${new Date(data.updatedAt).toLocaleString()}.` : 'Updated successfully.', 'success');
  });

  // --- Manage URLs Actions ---
  let currentUrlType = 'blocklist';
  const urlTextarea = document.getElementById('url-textarea');
  const urlStatus = document.getElementById('url-save-status');
  
  const tabBtns = document.querySelectorAll('.tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentUrlType = btn.getAttribute('data-type');
      loadUrls();
    });
  });

  function loadUrls() {
    urlTextarea.value = 'Loading...';
    socket.emit('get_urls', currentUrlType);
  }

  socket.on('urls_data', ({ type, urls }) => {
    if (type === currentUrlType) {
      urlTextarea.value = urls.join('\n');
    }
  });

  document.getElementById('btn-save-urls').addEventListener('click', () => {
    const urls = urlTextarea.value.split('\n').map(u => u.trim()).filter(Boolean);
    socket.emit('save_urls', { type: currentUrlType, urls });
    urlStatus.textContent = 'Saving...';
    urlStatus.className = 'status-msg';
  });

  socket.on('urls_saved', ({ success, error }) => {
    if (success) {
      urlStatus.textContent = 'Saved successfully!';
      urlStatus.className = 'status-msg success';
      setTimeout(() => { urlStatus.textContent = ''; }, 3000);
    } else {
      urlStatus.textContent = `Error: ${error}`;
      urlStatus.className = 'status-msg error';
    }
  });

  // --- DNS Rewrite Actions ---
  const rewritesUl = document.getElementById('rewrites-ul');
  const rewritesLoader = document.getElementById('rewrites-loader');
  const rewritesTextarea = document.getElementById('rewrites-textarea');
  const rewritesStatus = document.getElementById('rewrites-save-status');
  const btnSaveRewrites = document.getElementById('btn-save-rewrites');
  let loadedRewriteCount = 0;

  function loadDnsRewrites() {
    rewritesUl.textContent = '';
    rewritesLoader.style.display = 'block';
    socket.emit('get_dns_rewrites');
  }

  function renderRewriteMessage(message, colorVar) {
    rewritesUl.textContent = '';
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.style.color = `var(${colorVar})`;
    span.textContent = message;
    li.appendChild(span);
    rewritesUl.appendChild(li);
  }

  socket.on('dns_rewrites_data', ({ rewrites }) => {
    loadedRewriteCount = rewrites.length;
    rewritesLoader.style.display = 'none';
    rewritesUl.textContent = '';
    rewritesTextarea.value = rewrites
      .map(({ domain, ips }) => `${domain} -> ${ips.join(', ')}`)
      .join('\n');

    if (rewrites.length === 0) {
      renderRewriteMessage('No rewrites configured.', '--text-muted');
      return;
    }

    for (const { domain, ips } of rewrites) {
      const li = document.createElement('li');
      
      const info = document.createElement('span');
      info.textContent = `${domain} -> ${ips.join(', ')}`;
      li.appendChild(info);

      const delBtn = document.createElement('button');
      delBtn.className = 'btn-delete-rewrite';
      delBtn.title = `Delete rewrite for ${domain}`;
      delBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
      `;
      
      delBtn.addEventListener('click', () => {
        deleteRewrite(domain);
      });

      li.appendChild(delBtn);
      rewritesUl.appendChild(li);
    }
  });

  function deleteRewrite(domainToDelete) {
    const lines = rewritesTextarea.value.split('\n');
    const filteredLines = lines.filter(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return true;
      
      // Basic extraction of domain from line (domain -> IP or domain IP)
      const normalizedLine = trimmed
        .replace(/\s*->\s*/, ' ')
        .replace(/\s*=\s*/, ' ')
        .replace(/\s+/g, ' ');
      const domain = normalizedLine.split(/[,\s]+/)[0]?.trim().toLowerCase();
      
      return domain !== domainToDelete.toLowerCase();
    });

    const newRaw = filteredLines.join('\n');
    rewritesTextarea.value = newRaw;
    
    // Automatically trigger save
    term.writeln(`\x1b[33mDeleting DNS rewrite for: ${domainToDelete}\x1b[0m`);
    socket.emit('save_dns_rewrites', { raw: newRaw });
    
    rewritesStatus.textContent = 'Deleting...';
    rewritesStatus.className = 'status-msg';
  }

  socket.on('dns_rewrites_error', ({ error }) => {
    rewritesLoader.style.display = 'none';
    renderRewriteMessage(`Error loading rewrites: ${error}`, '--danger');
  });

  btnSaveRewrites.addEventListener('click', () => {
    const raw = rewritesTextarea.value.trim();
    if (!raw && loadedRewriteCount > 0 && !confirm('Save an empty rewrite list? This will delete all dashboard-managed DNS rewrite rules.')) {
      return;
    }

    btnSaveRewrites.disabled = true;
    rewritesStatus.textContent = 'Saving...';
    rewritesStatus.className = 'status-msg';
    term.writeln('\x1b[36m--- Saving DNS rewrites ---\x1b[0m');
    socket.emit('save_dns_rewrites', { raw });
  });

  socket.on('dns_rewrites_saved', ({ success, error, invalidCount }) => {
    btnSaveRewrites.disabled = false;
    if (success) {
      rewritesStatus.textContent = invalidCount > 0 ? `Saved with ${invalidCount} skipped line(s).` : 'Saved successfully!';
      rewritesStatus.className = 'status-msg success';
      loadDnsRewrites();
      setTimeout(() => { rewritesStatus.textContent = ''; }, 3000);
    } else {
      rewritesStatus.textContent = `Error: ${error}`;
      rewritesStatus.className = 'status-msg error';
    }
  });

  // --- Manage Allowlist Actions ---
  const allowlistUl = document.getElementById('allowlist-ul');
  const allowlistLoader = document.getElementById('allowlist-loader');
  const allowlistTextarea = document.getElementById('allowlist-textarea');
  let customListId = null;

  function loadAllowlist() {
    allowlistUl.textContent = '';
    allowlistLoader.style.display = 'block';
    socket.emit('get_custom_allowlist');
  }

  function renderAllowlistMessage(message, colorVar) {
    allowlistUl.textContent = '';
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.style.color = `var(${colorVar})`;
    span.textContent = message;
    li.appendChild(span);
    allowlistUl.appendChild(li);
  }

  socket.on('custom_allowlist_data', ({ id, items }) => {
    customListId = id;
    allowlistLoader.style.display = 'none';
    allowlistUl.textContent = '';
    if (items.length === 0) {
      renderAllowlistMessage('List is empty.', '--text-muted');
      return;
    }
    for (const domain of items) {
      const li = document.createElement('li');
      li.textContent = domain;
      allowlistUl.appendChild(li);
    }
  });

  socket.on('custom_allowlist_error', ({ error }) => {
    allowlistLoader.style.display = 'none';
    renderAllowlistMessage(`Error loading list: ${error}`, '--danger');
  });

  function handleAllowlistAction(action) {
    if (!customListId) return alert('Allowlist not loaded yet.');
    const raw = allowlistTextarea.value;
    const domains = raw.split(/[\s,]+/).map(d => d.trim().toLowerCase()).filter(Boolean);
    
    if (domains.length === 0) return alert('Please enter at least one valid domain.');
    
    // Disable buttons
    document.getElementById('btn-allowlist-add').disabled = true;
    document.getElementById('btn-allowlist-remove').disabled = true;
    
    term.writeln(`\x1b[36m--- Allowlist ${action} ---\x1b[0m`);
    socket.emit('manage_allowlist', { action, listId: customListId, domains });
  }

  document.getElementById('btn-allowlist-add').addEventListener('click', () => handleAllowlistAction('add'));
  document.getElementById('btn-allowlist-remove').addEventListener('click', () => handleAllowlistAction('remove'));

  socket.on('manage_allowlist_success', () => {
    document.getElementById('btn-allowlist-add').disabled = false;
    document.getElementById('btn-allowlist-remove').disabled = false;
    allowlistTextarea.value = '';
    loadAllowlist(); // Refresh list
  });

  // --- Manage Denylist Actions ---
  const denylistUl = document.getElementById('denylist-ul');
  const denylistLoader = document.getElementById('denylist-loader');
  const denylistTextarea = document.getElementById('denylist-textarea');
  let customDenyListId = null;

  function loadDenylist() {
    denylistUl.textContent = '';
    denylistLoader.style.display = 'block';
    socket.emit('get_custom_denylist');
  }

  function renderDenylistMessage(message, colorVar) {
    denylistUl.textContent = '';
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.style.color = `var(${colorVar})`;
    span.textContent = message;
    li.appendChild(span);
    denylistUl.appendChild(li);
  }

  socket.on('custom_denylist_data', ({ id, items }) => {
    customDenyListId = id;
    denylistLoader.style.display = 'none';
    denylistUl.textContent = '';
    if (items.length === 0) {
      renderDenylistMessage('List is empty.', '--text-muted');
      return;
    }
    for (const domain of items) {
      const li = document.createElement('li');
      li.textContent = domain;
      denylistUl.appendChild(li);
    }
  });

  socket.on('custom_denylist_error', ({ error }) => {
    denylistLoader.style.display = 'none';
    renderDenylistMessage(`Error loading list: ${error}`, '--danger');
  });

  function handleDenylistAction(action) {
    if (!customDenyListId) return alert('Denylist not loaded yet.');
    const raw = denylistTextarea.value;
    const domains = raw.split(/[\s,]+/).map(d => d.trim().toLowerCase()).filter(Boolean);
    
    if (domains.length === 0) return alert('Please enter at least one valid domain.');
    
    document.getElementById('btn-denylist-add').disabled = true;
    document.getElementById('btn-denylist-remove').disabled = true;
    
    term.writeln(`\x1b[36m--- Denylist ${action} ---\x1b[0m`);
    socket.emit('manage_denylist', { action, listId: customDenyListId, domains });
  }

  document.getElementById('btn-denylist-add').addEventListener('click', () => handleDenylistAction('add'));
  document.getElementById('btn-denylist-remove').addEventListener('click', () => handleDenylistAction('remove'));

  socket.on('manage_denylist_success', () => {
    document.getElementById('btn-denylist-add').disabled = false;
    document.getElementById('btn-denylist-remove').disabled = false;
    denylistTextarea.value = '';
    loadDenylist();
  });

  // Handle settings form - Removed as per request.

  // DNS Analytics
  let dnsChart = null;
  let currentDNSRange = '24h';
  const btnRefreshAnalytics = document.getElementById('btn-refresh-analytics');
  const analyticsTotalQueries = document.getElementById('analytics-total-queries');
  const analyticsTimePeriod = document.getElementById('analytics-time-period');
  const topDomainsList = document.getElementById('top-domains-list');
  const topLocationsList = document.getElementById('top-locations-list');
  const topDomainsLoader = document.getElementById('top-domains-loader');
  const topLocationsLoader = document.getElementById('top-locations-loader');
  const resolverDecisionsLoader = document.getElementById('resolver-decisions-loader');
  const resolverDecisionsLegend = document.getElementById('resolver-decisions-legend');
  const dnsRangePills = document.getElementById('dns-range-pills');
  const dnsDataStatus = document.getElementById('dns-data-status');
  let resolverDecisionChart = null;

  const RESOLVER_DECISION_COLORS = {
    5: '#3b82f6',
    9: '#f59e0b',
    10: '#ec4899',
  };
  const RESOLVER_DECISION_FALLBACK_COLORS = ['#22c55e', '#a855f7', '#14b8a6', '#ef4444', '#eab308', '#6366f1'];

  function renderResolverDecisions(decisions) {
    if (!decisions || decisions.length === 0) {
      if (resolverDecisionsLegend) resolverDecisionsLegend.innerHTML = '';
      if (resolverDecisionChart) {
        resolverDecisionChart.data.labels = [];
        resolverDecisionChart.data.datasets[0].data = [];
        resolverDecisionChart.update();
      }
      return;
    }

    const colors = decisions.map((d, i) => RESOLVER_DECISION_COLORS[d.metric] || RESOLVER_DECISION_FALLBACK_COLORS[i % RESOLVER_DECISION_FALLBACK_COLORS.length]);

    const canvas = document.getElementById('resolver-decision-chart');
    if (canvas && !resolverDecisionChart) {
      resolverDecisionChart = new Chart(canvas.getContext('2d'), {
        type: 'doughnut',
        data: {
          labels: decisions.map(d => d.label),
          datasets: [{
            data: decisions.map(d => d.count),
            backgroundColor: colors,
            borderColor: 'rgba(11, 18, 36, 0.9)',
            borderWidth: 2,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '65%',
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: 'rgba(11, 18, 36, 0.95)',
              titleColor: '#e8f1ff',
              bodyColor: '#d8e7ff',
              borderColor: 'rgba(125, 182, 255, 0.3)',
              borderWidth: 1,
              padding: 10,
              callbacks: {
                label: function(ctx) {
                  return `${ctx.label}: ${ctx.parsed.toLocaleString()}`;
                },
              },
            },
          },
        },
      });
    } else if (resolverDecisionChart) {
      resolverDecisionChart.data.labels = decisions.map(d => d.label);
      resolverDecisionChart.data.datasets[0].data = decisions.map(d => d.count);
      resolverDecisionChart.data.datasets[0].backgroundColor = colors;
      resolverDecisionChart.update();
    }

    if (resolverDecisionsLegend) {
      resolverDecisionsLegend.innerHTML = decisions.map((d, i) => `
        <li class="resolver-decision-item">
          <span class="resolver-decision-dot" style="background:${colors[i]}"></span>
          <span class="resolver-decision-label">${d.label}</span>
          <span class="resolver-decision-count">${formatNumber(d.count)}</span>
        </li>
      `).join('');
    }
  }

  function initDNSChart() {
    const ctx = document.getElementById('dns-queries-chart').getContext('2d');
    dnsChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label: 'DNS Queries',
          data: [],
          borderColor: '#7db6ff',
          backgroundColor: 'rgba(125, 182, 255, 0.1)',
          borderWidth: 2,
          fill: true,
          tension: 0.4,
          pointRadius: 3,
          pointBackgroundColor: '#7db6ff',
          pointBorderColor: '#ffffff',
          pointBorderWidth: 2,
          spanGaps: true, // Connect points even with gaps
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: false
          },
          tooltip: {
            backgroundColor: 'rgba(11, 18, 36, 0.95)',
            titleColor: '#e8f1ff',
            bodyColor: '#d8e7ff',
            borderColor: 'rgba(125, 182, 255, 0.3)',
            borderWidth: 1,
            padding: 12,
            displayColors: false,
            callbacks: {
              title: function(context) {
                const dataPoint = context[0];
                const timeStr = dataPoint.label;
                // Parse the time string and format full timestamp
                const date = new Date(timeStr);
                if (!isNaN(date.getTime())) {
                  // Full timestamp: "May 13, 2026 11:30:00"
                  return date.toLocaleString('en-US', {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: false,
                    timeZone: 'UTC'
                  });
                }
                return timeStr;
              },
              label: function(context) {
                return `Queries: ${context.parsed.y.toLocaleString()}`;
              }
            }
          }
        },
        scales: {
          x: {
            type: 'category',
            grid: {
              color: 'rgba(125, 182, 255, 0.1)',
              drawBorder: false,
              drawTicks: true,
              tickLength: 5,
              tickColor: function(context) {
                const index = context.index;
                const totalLabels = context.scale.ticks.length;
                const isMobile = window.innerWidth < 720;
                let isLabeled;
                if (isMobile) {
                  const positions = [
                    0,
                    Math.floor((totalLabels - 1) * 0.25),
                    Math.floor((totalLabels - 1) * 0.5),
                    Math.floor((totalLabels - 1) * 0.75),
                    totalLabels - 1,
                  ];
                  isLabeled = positions.includes(index);
                } else {
                  const step = Math.max(1, Math.ceil(totalLabels / 8));
                  isLabeled = index === 0 || index === totalLabels - 1 || index % step === 0;
                }
                return isLabeled ? 'rgba(125, 182, 255, 0.1)' : 'transparent';
              }
            },
            ticks: {
              color: '#8fa3c0',
              maxRotation: 0,
              autoSkip: false,
              autoSkipPadding: 20,
              callback: function(value, index, values) {
                const label = this.getLabelForValue(value);
                const date = new Date(label);
                if (!isNaN(date.getTime())) {
                  const totalLabels = values.length;
                  const isMobile = window.innerWidth < 720;
                  
                  if (isMobile) {
                    const positions = [
                      0,
                      Math.floor((totalLabels - 1) * 0.25),
                      Math.floor((totalLabels - 1) * 0.5),
                      Math.floor((totalLabels - 1) * 0.75),
                      totalLabels - 1,
                    ];

                    if (!positions.includes(index)) {
                      return '';
                    }
                  } else {
                    const step = Math.max(1, Math.ceil(totalLabels / 8));

                    if (index !== 0 && index !== totalLabels - 1 && index % step !== 0) {
                      return '';
                    }
                  }
                  
                  // Desktop: format normally
                  const hours = date.getHours();
                  const minutes = date.getMinutes();
                  
                  if (hours === 0 && minutes === 0) {
                    return date.toLocaleDateString('en-US', { 
                      month: 'short', 
                      day: 'numeric'
                    });
                  }
                  
                  return date.toLocaleTimeString('en-US', { 
                    hour: '2-digit', 
                    minute: '2-digit',
                    hour12: false
                  });
                }
                return '';
              }
            }
          },
          y: {
            min: 0,
            grid: {
              color: 'rgba(125, 182, 255, 0.1)',
              drawBorder: false
            },
            ticks: {
              color: '#8fa3c0',
              callback: function(value) {
                if (value >= 1000) {
                  return (value / 1000).toFixed(1) + 'k';
                }
                return value;
              }
            }
          }
        },
        interaction: {
          intersect: false,
          mode: 'index'
        }
      }
    });
  }

  function formatNumber(num) {
    if (num >= 1000) {
      return (num / 1000).toFixed(2) + 'k';
    }
    return num.toString();
  }

  function formatTimeLabel(timeStr) {
    const date = new Date(timeStr);
    // Format as HH:MM for 15-minute intervals
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function formatDateTimeLabel(timeStr) {
    const date = new Date(timeStr);
    // Format as MM/DD HH:MM for tooltip
    return date.toLocaleString('en-US', { 
      month: 'short', 
      day: 'numeric',
      hour: '2-digit', 
      minute: '2-digit', 
      hour12: false 
    });
  }

  function renderTopList(container, items, key) {
    container.innerHTML = '';
    if (items.length === 0) {
      const li = document.createElement('li');
      li.className = 'top-list-empty';
      li.textContent = 'No data available';
      container.appendChild(li);
      return;
    }

    items.forEach((item, index) => {
      const li = document.createElement('li');
      li.className = 'top-list-item';
      li.innerHTML = `
        <span class="top-list-rank">${index + 1}</span>
        <span class="top-list-name" title="${item[key]}">${item[key]}</span>
        <span class="top-list-count">${formatNumber(item.count)}</span>
      `;
      container.appendChild(li);
    });
  }

  function updateDNSStatus(source, cachedAt) {
    if (!dnsDataStatus) return;
    dnsDataStatus.className = 'data-status data-timestamp';
    const formatStatusTime = value => new Date(value || Date.now()).toLocaleTimeString();
    
    if (source === 'live') {
      dnsDataStatus.classList.add('live');
      dnsDataStatus.textContent = `Live ${formatStatusTime(cachedAt)}`;
      dnsDataStatus.title = `Live data at ${new Date(cachedAt || Date.now()).toLocaleString()}`;
    } else if (source === 'cache' && cachedAt) {
      dnsDataStatus.classList.add('cache');
      const date = new Date(cachedAt);
      dnsDataStatus.textContent = `Cached ${formatStatusTime(cachedAt)}`;
      dnsDataStatus.title = `Cached at ${date.toLocaleString()}`;
    } else if (source === 'loading') {
      dnsDataStatus.classList.add('loading');
      dnsDataStatus.textContent = 'Loading...';
      dnsDataStatus.title = 'Loading...';
    } else if (source === 'error') {
      dnsDataStatus.classList.add('error');
      dnsDataStatus.textContent = 'Error';
      dnsDataStatus.title = 'Failed to load data';
    } else {
      dnsDataStatus.textContent = 'No data';
      dnsDataStatus.title = 'No data';
    }
  }

  function setDNSRange(range) {
    currentDNSRange = range;
    emitDashboardViewState({ dnsRange: range });
    
    // Update pill UI
    if (dnsRangePills) {
      dnsRangePills.querySelectorAll('.range-pill').forEach(pill => {
        pill.classList.toggle('active', pill.dataset.range === range);
      });
    }
    
    // Update time period text
    const rangeLabels = { '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days' };
    if (analyticsTimePeriod) analyticsTimePeriod.textContent = rangeLabels[range] || 'Last 24 hours';
    
    // Load data for new range
    loadDNSAnalytics(range);
  }

  function loadDNSAnalytics(range = currentDNSRange) {
    const rangeLabels = { '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days' };
    if (analyticsTimePeriod) analyticsTimePeriod.textContent = rangeLabels[range] || 'Last 24 hours';

    // Show loaders if no cached data yet
    if (topDomainsLoader) topDomainsLoader.style.display = 'block';
    if (topLocationsLoader) topLocationsLoader.style.display = 'block';
    if (resolverDecisionsLoader) resolverDecisionsLoader.style.display = 'block';
    
    updateDNSStatus('loading', null);
    socket.emit('get_dns_analytics', { range });
  }

  // Range pill click handlers
  if (dnsRangePills) {
    dnsRangePills.querySelectorAll('.range-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        const range = pill.dataset.range;
        if (range && range !== currentDNSRange) {
          setDNSRange(range);
        }
      });
    });
  }

  socket.on('dns_analytics_data', ({ success, timeSeries, totalCount, topDomains, topLocations, resolverDecisions, range, source, cachedAt, startTime, endTime, error }) => {
    if (topDomainsLoader) topDomainsLoader.style.display = 'none';
    if (topLocationsLoader) topLocationsLoader.style.display = 'none';
    if (resolverDecisionsLoader) resolverDecisionsLoader.style.display = 'none';

    if (!success) {
      console.error('DNS analytics error:', error);
      analyticsTotalQueries.textContent = 'Error';
      updateDNSStatus('error', null);
      return;
    }

    // Only update if this is for our current range
    if (range && range !== currentDNSRange) return;

    // Update status indicator
    updateDNSStatus(source, cachedAt);

    // Update total queries
    analyticsTotalQueries.textContent = formatNumber(totalCount);

    // Update chart
    if (dnsChart && timeSeries) {
      const labels = timeSeries.map(d => d.time);
      const data = timeSeries.map(d => d.count);

      if (startTime && endTime) {
        if (!labels.includes(startTime)) {
          labels.unshift(startTime);
          data.unshift(null);
        }

        if (!labels.includes(endTime)) {
          labels.push(endTime);
          data.push(null);
        }
      }

      // Dynamic Y-axis: bottom fixed at 0, top = ceil(max * 1.1) with 10% headroom
      const numericValues = data.filter(v => v != null && !isNaN(v));
      if (numericValues.length > 0) {
        const maxVal = Math.max(...numericValues);
        dnsChart.options.scales.y.min = 0;
        dnsChart.options.scales.y.max = Math.ceil(maxVal * 1.1);
      } else {
        dnsChart.options.scales.y.min = 0;
        dnsChart.options.scales.y.max = undefined;
      }

      dnsChart.data.labels = labels;
      dnsChart.data.datasets[0].data = data;
      dnsChart.update();
    }

    // Update top lists
    if (topDomains) renderTopList(topDomainsList, topDomains, 'domain');
    if (topLocations) renderTopList(topLocationsList, topLocations, 'location');
    if (resolverDecisions) renderResolverDecisions(resolverDecisions);
  });

  // Initialize chart when analytics section is shown
  const analyticsNavBtn = document.querySelector('[data-target="dns-analytics"]');
  if (analyticsNavBtn) {
    analyticsNavBtn.addEventListener('click', () => {
      if (!dnsChart) {
        initDNSChart();
        loadDNSAnalytics();
      }
    });
  }

  // Auto-load analytics on initial page load (DNS Analytics is default section)
  if (document.getElementById('section-dns-analytics')?.classList.contains('active') && !dnsChart) {
    initDNSChart();
    loadDNSAnalytics();
  }

  if (btnRefreshAnalytics) {
    btnRefreshAnalytics.addEventListener('click', () => {
      // Clear existing chart data before refreshing
      if (dnsChart) {
        dnsChart.data.labels = [];
        dnsChart.data.datasets[0].data = [];
        dnsChart.update('none');
      }
      // Force live refresh
      updateDNSStatus('loading', null);
      socket.emit('get_dns_analytics', { range: currentDNSRange, skipLive: false });
    });
  }

  if (document.getElementById('section-traffic-map')?.classList.contains('active')) {
    trafficMapDashboard?.load();
  }
});
