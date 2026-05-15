(() => {
  const COUNTRY_NAMES = {
    AF:'Afghanistan',AX:'Åland Islands',AL:'Albania',DZ:'Algeria',AS:'American Samoa',
    AD:'Andorra',AO:'Angola',AI:'Anguilla',AQ:'Antarctica',AG:'Antigua and Barbuda',
    AR:'Argentina',AM:'Armenia',AW:'Aruba',AU:'Australia',AT:'Austria',
    AZ:'Azerbaijan',BS:'Bahamas',BH:'Bahrain',BD:'Bangladesh',BB:'Barbados',
    BY:'Belarus',BE:'Belgium',BZ:'Belize',BJ:'Benin',BM:'Bermuda',
    BT:'Bhutan',BO:'Bolivia',BQ:'Bonaire',BA:'Bosnia and Herzegovina',BW:'Botswana',
    BV:'Bouvet Island',BR:'Brazil',IO:'British Indian Ocean Territory',BN:'Brunei',BG:'Bulgaria',
    BF:'Burkina Faso',BI:'Burundi',CV:'Cabo Verde',KH:'Cambodia',CM:'Cameroon',
    CA:'Canada',KY:'Cayman Islands',CF:'Central African Republic',TD:'Chad',CL:'Chile',
    CN:'China',CX:'Christmas Island',CC:'Cocos Islands',CO:'Colombia',KM:'Comoros',
    CG:'Congo',CD:'DR Congo',CK:'Cook Islands',CR:'Costa Rica',CI:'Côte d\'Ivoire',
    HR:'Croatia',CU:'Cuba',CW:'Curaçao',CY:'Cyprus',CZ:'Czechia',
    DK:'Denmark',DJ:'Djibouti',DM:'Dominica',DO:'Dominican Republic',EC:'Ecuador',
    EG:'Egypt',SV:'El Salvador',GQ:'Equatorial Guinea',ER:'Eritrea',EE:'Estonia',
    SZ:'Eswatini',ET:'Ethiopia',FK:'Falkland Islands',FO:'Faroe Islands',FJ:'Fiji',
    FI:'Finland',FR:'France',GF:'French Guiana',PF:'French Polynesia',TF:'French Southern Territories',
    GA:'Gabon',GM:'Gambia',GE:'Georgia',DE:'Germany',GH:'Ghana',
    GI:'Gibraltar',GR:'Greece',GL:'Greenland',GD:'Grenada',GP:'Guadeloupe',
    GU:'Guam',GT:'Guatemala',GG:'Guernsey',GN:'Guinea',GW:'Guinea-Bissau',
    GY:'Guyana',HT:'Haiti',HM:'Heard Island',VA:'Vatican City',HN:'Honduras',
    HK:'Hong Kong',HU:'Hungary',IS:'Iceland',IN:'India',ID:'Indonesia',
    IR:'Iran',IQ:'Iraq',IE:'Ireland',IM:'Isle of Man',IL:'Israel',
    IT:'Italy',JM:'Jamaica',JP:'Japan',JE:'Jersey',JO:'Jordan',
    KZ:'Kazakhstan',KE:'Kenya',KI:'Kiribati',KP:'North Korea',KR:'South Korea',
    KW:'Kuwait',KG:'Kyrgyzstan',LA:'Laos',LV:'Latvia',LB:'Lebanon',
    LS:'Lesotho',LR:'Liberia',LY:'Libya',LI:'Liechtenstein',LT:'Lithuania',
    LU:'Luxembourg',MO:'Macao',MG:'Madagascar',MW:'Malawi',MY:'Malaysia',
    MV:'Maldives',ML:'Mali',MT:'Malta',MH:'Marshall Islands',MQ:'Martinique',
    MR:'Mauritania',MU:'Mauritius',YT:'Mayotte',MX:'Mexico',FM:'Micronesia',
    MD:'Moldova',MC:'Monaco',MN:'Mongolia',ME:'Montenegro',MS:'Montserrat',
    MA:'Morocco',MZ:'Mozambique',MM:'Myanmar',NA:'Namibia',NR:'Nauru',
    NP:'Nepal',NL:'Netherlands',NC:'New Caledonia',NZ:'New Zealand',NI:'Nicaragua',
    NE:'Niger',NG:'Nigeria',NU:'Niue',NF:'Norfolk Island',MK:'North Macedonia',
    MP:'Northern Mariana Islands',NO:'Norway',OM:'Oman',PK:'Pakistan',PW:'Palau',
    PS:'Palestine',PA:'Panama',PG:'Papua New Guinea',PY:'Paraguay',PE:'Peru',
    PH:'Philippines',PN:'Pitcairn',PL:'Poland',PT:'Portugal',PR:'Puerto Rico',
    QA:'Qatar',RE:'Réunion',RO:'Romania',RU:'Russia',RW:'Rwanda',
    BL:'Saint Barthélemy',SH:'Saint Helena',KN:'Saint Kitts and Nevis',LC:'Saint Lucia',MF:'Saint Martin',
    PM:'Saint Pierre and Miquelon',VC:'Saint Vincent',WS:'Samoa',SM:'San Marino',ST:'São Tomé and Príncipe',
    SA:'Saudi Arabia',SN:'Senegal',RS:'Serbia',SC:'Seychelles',SL:'Sierra Leone',
    SG:'Singapore',SX:'Sint Maarten',SK:'Slovakia',SI:'Slovenia',SB:'Solomon Islands',
    SO:'Somalia',ZA:'South Africa',GS:'South Georgia',SS:'South Sudan',ES:'Spain',
    LK:'Sri Lanka',SD:'Sudan',SR:'Suriname',SJ:'Svalbard and Jan Mayen',SE:'Sweden',
    CH:'Switzerland',SY:'Syria',TW:'Taiwan',TJ:'Tajikistan',TZ:'Tanzania',
    TH:'Thailand',TL:'Timor-Leste',TG:'Togo',TK:'Tokelau',TO:'Tonga',
    TT:'Trinidad and Tobago',TN:'Tunisia',TR:'Turkey',TM:'Turkmenistan',TC:'Turks and Caicos Islands',
    TV:'Tuvalu',UG:'Uganda',UA:'Ukraine',AE:'United Arab Emirates',GB:'United Kingdom',
    UM:'US Minor Outlying Islands',US:'United States',UY:'Uruguay',UZ:'Uzbekistan',VU:'Vanuatu',
    VE:'Venezuela',VN:'Vietnam',VG:'British Virgin Islands',VI:'US Virgin Islands',WF:'Wallis and Futuna',
    EH:'Western Sahara',YE:'Yemen',ZM:'Zambia',ZW:'Zimbabwe',
  };

  window.createTrafficMapDashboard = function createTrafficMapDashboard(socket) {
    const svgEl = document.getElementById('traffic-map-svg');
    const cometCanvas = document.getElementById('traffic-map-comets');
    const tooltipEl = document.getElementById('traffic-map-tooltip');
    const loadingEl = document.getElementById('traffic-map-loading');
    const errorEl = document.getElementById('traffic-map-error');
    const errorMsgEl = document.getElementById('traffic-map-error-msg');
    const updatedBadge = document.getElementById('traffic-map-updated');
    const legendEl = document.getElementById('traffic-map-legend');
    const legendListEl = document.getElementById('traffic-map-legend-list');
    const refreshBtn = document.getElementById('btn-refresh-traffic-map');
    const zoomInBtn = document.getElementById('traffic-map-zoom-in');
    const zoomOutBtn = document.getElementById('traffic-map-zoom-out');
    const zoomResetBtn = document.getElementById('traffic-map-zoom-reset');
    const rangePills = document.getElementById('traffic-range-pills');
    const dataStatus = document.getElementById('traffic-data-status');
    let currentRange = '24h';

    if (!svgEl || !cometCanvas || !window.d3 || !window.topojson) return null;

    const cometCtx = cometCanvas.getContext('2d');
    const svg = d3.select(svgEl);
    const formatNumber = n => Number(n || 0).toLocaleString();
    const escapeHtml = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const countryLabel = code => COUNTRY_NAMES[code] || code || 'Unknown';
    const hexToRgb = hex => {
      const h = String(hex || '#ffffff').replace('#', '');
      const value = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
      return { r: value >> 16 & 255, g: value >> 8 & 255, b: value & 255 };
    };

    let projection;
    let pathGen;
    let zoomBehavior;
    let rootGroup;
    let cometTimer;
    let currentZoom = d3.zoomIdentity;
    let worldTopology;
    let initialized = false;
    let lastData = null;
    let loadingStarted = false;

    function visibleCountryFeatures() {
      if (!worldTopology) return [];
      return topojson.feature(worldTopology, worldTopology.objects.countries).features;
    }

    function setLoading(value) {
      if (loadingEl) loadingEl.hidden = !value;
      loadingStarted = value;
    }

    function showError(message) {
      if (!errorEl || !errorMsgEl) return;
      errorMsgEl.textContent = message;
      errorEl.hidden = false;
    }

    function clearError() {
      if (errorEl) errorEl.hidden = true;
    }

    function setupMap() {
      const stage = svgEl.parentElement;
      const width = Math.max(320, stage.clientWidth || 960);
      const height = Math.max(320, stage.clientHeight || 520);
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);

      cometCanvas.width = Math.round(width * dpr);
      cometCanvas.height = Math.round(height * dpr);
      cometCanvas.style.width = '100%';
      cometCanvas.style.height = '100%';
      svg.attr('viewBox', `0 0 ${width} ${height}`).attr('preserveAspectRatio', 'xMidYMid meet');

      const mapFeatures = visibleCountryFeatures();
      const projectionTarget = mapFeatures.length
        ? { type: 'FeatureCollection', features: mapFeatures }
        : { type: 'Sphere' };
      const padding = Math.max(14, Math.min(width, height) * 0.025);

      projection = d3.geoEquirectangular()
        .fitExtent([[padding, padding], [width - padding, height - padding]], projectionTarget);
      pathGen = d3.geoPath(projection);
      svg.selectAll('*').remove();
      rootGroup = svg.append('g').attr('class', 'traffic-map-root');
      rootGroup.append('g').attr('class', 'traffic-map-countries');
      rootGroup.append('g').attr('class', 'traffic-map-arcs');
      rootGroup.append('g').attr('class', 'traffic-map-destinations');
      rootGroup.append('g').attr('class', 'traffic-map-origins');

      currentZoom = d3.zoomIdentity;
      // translateExtent uses content coordinates — allow panning up to the full
      // zoomed content size (8x = max scale) so the user can reach every corner
      // but can never drag past the map edges into empty space.
      const maxScale = 8;
      zoomBehavior = d3.zoom()
        .scaleExtent([1, maxScale])
        .translateExtent([[-(width * (maxScale - 1)), -(height * (maxScale - 1))], [width * maxScale, height * maxScale]])
        .on('zoom', e => {
          currentZoom = e.transform;
          rootGroup.attr('transform', currentZoom);
        });
      svg.call(zoomBehavior);
    }

    function renderCountries() {
      if (!worldTopology || !rootGroup) return;
      const features = visibleCountryFeatures();
      rootGroup.select('.traffic-map-countries')
        .selectAll('path')
        .data(features)
        .join('path')
        .attr('class', 'traffic-map-country')
        .attr('d', pathGen);
    }

    function showTooltip(html, evt) {
      if (!tooltipEl) return;
      tooltipEl.innerHTML = html;
      tooltipEl.classList.add('visible');
      const pad = 14;
      const rect = tooltipEl.getBoundingClientRect();
      let x = evt.clientX + pad;
      let y = evt.clientY + pad;
      if (x + rect.width > window.innerWidth) x = evt.clientX - rect.width - pad;
      if (y + rect.height > window.innerHeight) y = evt.clientY - rect.height - pad;
      tooltipEl.style.left = `${x}px`;
      tooltipEl.style.top = `${y}px`;
    }

    function hideTooltip() {
      if (tooltipEl) tooltipEl.classList.remove('visible');
    }

    function curvedArc(src, dst) {
      const [sx, sy] = projection([src.lng, src.lat]);
      const [tx, ty] = projection([dst.lng, dst.lat]);
      const dx = tx - sx;
      const dy = ty - sy;
      const dr = Math.sqrt(dx * dx + dy * dy) * 1.3;
      return `M${sx},${sy}A${dr},${dr} 0 0,1 ${tx},${ty}`;
    }

    function sampleRoutePath(route, routeIndex, originColor, flowSpeed, tailScale, tailGapScale, cometSize) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', curvedArc(
        { lat: route.sourceLat, lng: route.sourceLng },
        { lat: route.destinationLat, lng: route.destinationLng }
      ));
      const length = path.getTotalLength();
      const sampleCount = Math.max(120, Math.min(420, Math.round(length * 0.9)));
      const xs = new Float32Array(sampleCount + 1);
      const ys = new Float32Array(sampleCount + 1);

      for (let i = 0; i <= sampleCount; i++) {
        const pt = path.getPointAtLength((i / sampleCount) * length);
        xs[i] = pt.x;
        ys[i] = pt.y;
      }

      const size = cometSize(route.count);
      const color = originColor(route.sourceCountry);
      const colorRgb = hexToRgb(color);
      const duration = flowSpeed(route.count) * 1000;
      return {
        xs,
        ys,
        sampleCount,
        start: performance.now() - (Math.random() * duration),
        duration,
        color,
        colorRgb,
        tailEndOffset: tailScale(route.count) * tailGapScale(route.count),
        size,
      };
    }

    function sampleAt(routePath, t) {
      const f = Math.max(0, Math.min(1, t)) * routePath.sampleCount;
      const i = Math.min(routePath.sampleCount - 1, f | 0);
      const frac = f - i;
      return {
        x: routePath.xs[i] + (routePath.xs[i + 1] - routePath.xs[i]) * frac,
        y: routePath.ys[i] + (routePath.ys[i + 1] - routePath.ys[i]) * frac,
      };
    }

    function startComets(routePaths) {
      if (cometTimer) cometTimer.stop();
      cometTimer = d3.timer(() => {
        const now = performance.now(); // always use wall-clock so start offsets stay valid after refresh
        const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
        cometCtx.setTransform(1, 0, 0, 1, 0, 0);
        cometCtx.clearRect(0, 0, cometCanvas.width, cometCanvas.height);
        cometCtx.setTransform(dpr * currentZoom.k, 0, 0, dpr * currentZoom.k, dpr * currentZoom.x, dpr * currentZoom.y);
        cometCtx.globalCompositeOperation = 'lighter';
        cometCtx.lineCap = 'round';

        for (const rp of routePaths) {
          const headProgress = ((now - rp.start) / rp.duration) % 1;
          const startProgress = Math.max(0, headProgress - rp.tailEndOffset);
          const tailStart = sampleAt(rp, startProgress);
          const head = sampleAt(rp, headProgress);
          const gradient = cometCtx.createLinearGradient(tailStart.x, tailStart.y, head.x, head.y);
          gradient.addColorStop(0, `rgba(${rp.colorRgb.r}, ${rp.colorRgb.g}, ${rp.colorRgb.b}, 0)`);
          gradient.addColorStop(0.45, `rgba(${rp.colorRgb.r}, ${rp.colorRgb.g}, ${rp.colorRgb.b}, 0.22)`);
          gradient.addColorStop(0.82, `rgba(${rp.colorRgb.r}, ${rp.colorRgb.g}, ${rp.colorRgb.b}, 0.7)`);
          gradient.addColorStop(1, `rgba(${rp.colorRgb.r}, ${rp.colorRgb.g}, ${rp.colorRgb.b}, 1)`);
          cometCtx.strokeStyle = gradient;
          cometCtx.lineWidth = Math.max(1.2, rp.size * 0.5);
          cometCtx.beginPath();

          for (let step = 0; step <= 18; step++) {
            const progress = startProgress + (headProgress - startProgress) * (step / 18);
            const p = sampleAt(rp, progress);
            if (step === 0) cometCtx.moveTo(p.x, p.y);
            else cometCtx.lineTo(p.x, p.y);
          }

          cometCtx.stroke();
          cometCtx.fillStyle = rp.color;
          cometCtx.shadowColor = rp.color;
          cometCtx.shadowBlur = rp.size * 2.2;
          cometCtx.beginPath();
          cometCtx.arc(head.x, head.y, rp.size, 0, Math.PI * 2);
          cometCtx.fill();
          cometCtx.shadowBlur = 0;
        }

        cometCtx.globalCompositeOperation = 'source-over';
      });
    }

    function render(data) {
      lastData = data;
      clearError();
      if (!rootGroup) return;

      const sources = (data.sources || []).filter(s => s.lat != null && s.lng != null);
      const destinations = (data.destinations || []).filter(d => d.lat != null && d.lng != null);
      const routes = (data.routes || []).filter(r => r.sourceLat != null && r.destinationLat != null).slice(0, 200);
      const maxDest = Math.max(1, ...destinations.map(d => d.count));
      const maxSrc = Math.max(1, ...sources.map(s => s.count));
      const maxRoute = Math.max(1, ...routes.map(r => r.count));

      // Compute a single scale factor based on the map's current rendered width.
      // This ensures all sizes are proportional to the visible map area.
      const mapW = Math.max(320, svgEl.parentElement?.clientWidth || 960);
      const mapH = Math.max(320, svgEl.parentElement?.clientHeight || 520);
      const mapScale = Math.min(mapW, mapH) / 700; // 700px is the reference size

      // All sizes are expressed as proportions of the map size, not raw pixels.
      // Min/max values are clamped so elements never grow absurdly large.
      const destR = d3.scaleSqrt().domain([1, maxDest]).range([
        Math.max(3, Math.min(6, 4 * mapScale)),
        Math.max(8, Math.min(16, 14 * mapScale)),
      ]);
      const pinSize = d3.scaleSqrt().domain([1, maxSrc]).range([0.7, 1.2]); // unitless scale factor, already safe
      const arcW = d3.scaleSqrt().domain([1, maxRoute]).range([
        Math.max(0.8, 1.2 * mapScale),
        Math.max(1.5, 3.0 * mapScale),
      ]);
      const palette = [...d3.schemeTableau10, ...d3.schemeSet2, ...d3.schemePaired];
      const originColor = d3.scaleOrdinal(palette).domain(sources.map(s => s.country));

      const arcSel = rootGroup.select('.traffic-map-arcs').selectAll('path').data(routes, r => `${r.sourceCountry}->${r.destinationCountry}`);
      arcSel.exit().remove();
      arcSel.enter().append('path')
        .attr('class', 'traffic-map-arc-path')
        .attr('fill', 'none')
        .on('mousemove', (e, d) => showTooltip(`<strong>${escapeHtml(countryLabel(d.sourceCountry))} → ${escapeHtml(countryLabel(d.destinationCountry))}</strong><br>${formatNumber(d.count)} queries`, e))
        .on('mouseleave', hideTooltip)
        .merge(arcSel)
        .attr('d', d => curvedArc({ lat: d.sourceLat, lng: d.sourceLng }, { lat: d.destinationLat, lng: d.destinationLng }))
        .attr('stroke', 'transparent')
        .attr('stroke-width', d => Math.max(12, arcW(d.count) * 4))
        .attr('opacity', 0);

      // Comet sizes are also proportional to map size
      const flowSpeed = d3.scalePow().exponent(0.35).domain([1, maxRoute]).range([3.4, 8.8]);
      const tailScale = d3.scalePow().exponent(0.35).domain([1, maxRoute]).range([16, 28]);
      const tailGapScale = d3.scalePow().exponent(0.35).domain([1, maxRoute]).range([0.018, 0.03]);
      const cometSize = d3.scalePow().exponent(0.35).domain([1, maxRoute]).range([
        Math.max(1.5, 2.2 * mapScale),
        Math.max(3.0, 5.5 * mapScale),
      ]);
      startComets(routes.map((route, index) => sampleRoutePath(route, index, originColor, flowSpeed, tailScale, tailGapScale, cometSize)));

      const destSel = rootGroup.select('.traffic-map-destinations').selectAll('circle').data(destinations, d => d.country);
      destSel.exit().remove();
      destSel.enter().append('circle')
        .attr('class', 'traffic-map-dest-bubble')
        .on('mousemove', (e, d) => showTooltip(`<strong>${escapeHtml(countryLabel(d.country))}</strong><br>${formatNumber(d.count)} destination queries`, e))
        .on('mouseleave', hideTooltip)
        .merge(destSel)
        .attr('cx', d => projection([d.lng, d.lat])[0])
        .attr('cy', d => projection([d.lng, d.lat])[1])
        .attr('r', d => destR(d.count));

      const pinPath = 'M0 0 C 0 0 -10 -8 -10 -16 A 10 10 0 1 1 10 -16 C 10 -8 0 0 0 0 Z';
      const srcSel = rootGroup.select('.traffic-map-origins').selectAll('g.traffic-map-origin-pin').data(sources, d => d.country);
      srcSel.exit().remove();
      const srcEnter = srcSel.enter().append('g')
        .attr('class', 'traffic-map-origin-pin')
        .on('mousemove', (e, d) => showTooltip(`<strong>Origin · ${escapeHtml(countryLabel(d.country))}</strong><br>${formatNumber(d.count)} queries`, e))
        .on('mouseleave', hideTooltip);
      srcEnter.append('path').attr('class', 'traffic-map-origin-pin-body').attr('d', pinPath);
      srcEnter.append('circle').attr('class', 'traffic-map-origin-pin-dot').attr('cx', 0).attr('cy', -16).attr('r', 3.5);
      const srcMerge = srcEnter.merge(srcSel);
      srcMerge.classed('primary', (d, i) => i === 0)
        .attr('transform', d => {
          const [x, y] = projection([d.lng, d.lat]);
          return `translate(${x}, ${y}) scale(${pinSize(d.count)})`;
        })
        .style('--pin-color', d => originColor(d.country));
      srcMerge.select('path.traffic-map-origin-pin-body').attr('fill', d => originColor(d.country));

      if (legendEl && legendListEl) {
        legendEl.hidden = sources.length === 0;
        const totalSrc = sources.reduce((sum, d) => sum + (d.count || 0), 0) || 1;
        legendListEl.innerHTML = sources.map(source => {
          const color = originColor(source.country);
          const label = countryLabel(source.country);
          return `<div class="traffic-map-legend-item" title="${escapeHtml(label)}"><span class="traffic-map-legend-swatch" style="background:${color}; border-radius: 50%; width: 6px; height: 6px;"></span><span class="traffic-map-legend-pair" style="font-weight: 500;">${escapeHtml(label)}</span><span class="traffic-map-legend-count" style="color: var(--accent); font-weight: 600;">${formatNumber(source.count)}</span></div>`;
        }).join('');
      }

      const destListEl = document.getElementById('traffic-map-dest-list');
      if (destListEl) {
        const totalDest = destinations.reduce((sum, d) => sum + (d.count || 0), 0) || 1;
        destListEl.innerHTML = destinations.map(dest => {
          const label = countryLabel(dest.country);
          return `<div class="traffic-map-legend-item" title="${escapeHtml(label)}"><span class="traffic-map-legend-pair" style="font-weight: 500;">${escapeHtml(label)}</span><span class="traffic-map-legend-count" style="color: var(--accent); font-weight: 600;">${formatNumber(dest.count)}</span></div>`;
        }).join('');
      }



      if (updatedBadge && data.updatedAt && !data.cachedAt) {
        updatedBadge.textContent = `Updated ${new Date(data.updatedAt).toLocaleTimeString()}`;
      }
    }

    async function ensureInitialized() {
      if (initialized) return;
      initialized = true;
      setLoading(true);
      const res = await fetch('/vendor/world-atlas/countries-110m.json');
      worldTopology = await res.json();
      setupMap();
      renderCountries();
    }

    async function load(options = {}) {
      try {
        await ensureInitialized();
        clearError();
        setLoading(true);
        socket.emit('get_traffic_map', options);
      } catch (e) {
        setLoading(false);
        showError(e.message);
      }
    }

    function updateStatusIndicator(source, cachedAt) {
      const formatStatusTime = value => new Date(value || Date.now()).toLocaleTimeString();
      if (dataStatus) {
        dataStatus.className = 'data-status';
      }
      if (updatedBadge) {
        updatedBadge.className = 'traffic-map-badge data-timestamp';
      }
      
      if (source === 'live') {
        if (dataStatus) dataStatus.classList.add('live');
        if (updatedBadge) {
          const date = new Date(cachedAt || Date.now());
          updatedBadge.classList.add('live');
          updatedBadge.textContent = `Live ${formatStatusTime(cachedAt)}`;
          updatedBadge.title = `Live data at ${date.toLocaleString()}`;
        }
      } else if (source === 'cache' && cachedAt) {
        if (dataStatus) dataStatus.classList.add('cache');
        const date = new Date(cachedAt);
        if (updatedBadge) {
          updatedBadge.classList.add('cache');
          updatedBadge.textContent = `Cached ${formatStatusTime(cachedAt)}`;
          updatedBadge.title = `Cached at ${date.toLocaleString()}`;
        }
      } else if (source === 'loading') {
        if (dataStatus) dataStatus.classList.add('loading');
        if (updatedBadge) {
          updatedBadge.classList.add('loading');
          updatedBadge.textContent = 'Loading...';
          updatedBadge.title = 'Loading...';
        }
      } else if (source === 'error') {
        if (updatedBadge) {
          updatedBadge.classList.add('error');
          updatedBadge.textContent = 'Error';
          updatedBadge.title = 'Failed to load data';
        }
      } else {
        if (updatedBadge) {
          updatedBadge.textContent = 'No data';
          updatedBadge.title = 'No data';
        }
      }
    }

    function setRange(range) {
      currentRange = range;
      
      // Update pill UI
      if (rangePills) {
        rangePills.querySelectorAll('.range-pill').forEach(pill => {
          pill.classList.toggle('active', pill.dataset.range === range);
        });
      }
      
      // Load data for new range
      load({ range });
    }

    // Range pill click handlers
    if (rangePills) {
      rangePills.querySelectorAll('.range-pill').forEach(pill => {
        pill.addEventListener('click', () => {
          const range = pill.dataset.range;
          if (range && range !== currentRange) {
            setRange(range);
          }
        });
      });
    }

    socket.on('traffic_map_data', data => {
      if (!data || data.success === false) {
        setLoading(false);
        showError(data?.error || 'Failed to load traffic map');
        updateStatusIndicator('error', null);
        return;
      }
      
      // Only update if this is for our current range
      if (data.range && data.range !== currentRange) return;

      setLoading(false);
      
      // Update status indicator
      updateStatusIndicator(data.source, data.cachedAt);
      
      render(data);
    });

    if (refreshBtn) refreshBtn.addEventListener('click', () => {
      updateStatusIndicator('loading', null);
      load({ range: currentRange, force: true });
    });
    if (zoomInBtn) zoomInBtn.addEventListener('click', () => svg.transition().call(zoomBehavior.scaleBy, 1.5));
    if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => svg.transition().call(zoomBehavior.scaleBy, 1 / 1.5));
    if (zoomResetBtn) zoomResetBtn.addEventListener('click', () => svg.transition().call(zoomBehavior.transform, d3.zoomIdentity));

    let resizeTimer;
    const observer = new ResizeObserver(() => {
      if (!initialized) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        setupMap();
        renderCountries();
        if (lastData) render(lastData);
      }, 150);
    });
    if (svgEl.parentElement) {
      observer.observe(svgEl.parentElement);
    }

    return { load, ensureInitialized, isLoading: () => loadingStarted };
  };
})();
