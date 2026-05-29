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
    const toggleLockBtn = document.getElementById('traffic-map-toggle-lock');
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
    let dragBehavior;
    let rootGroup;
    let rotationTimer;
    let worldTopology;
    let initialized = false;
    let lastData = null;
    let loadingStarted = false;
    let canvasWidth = 0;
    let canvasHeight = 0;
    let baseScale = 1;
    let zoomScale = 1;
    let dpr = 1;
    const fixedGlobeTilt = -18;
    let globeRotation = [-142, fixedGlobeTilt, 0];
    let isDraggingGlobe = false;
    let pulseRoutes = [];
    const pulsePhaseByRoute = new Map();
    let reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
    let userUnlockedMap = false;
    let isPinching = false;

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
      dpr = Math.min(window.devicePixelRatio || 1, width < 520 ? 1.25 : 1.5);
      const compactGlobe = width < 540;
      canvasWidth = width;
      canvasHeight = height;

      cometCanvas.width = Math.round(width * dpr);
      cometCanvas.height = Math.round(height * dpr);
      cometCanvas.style.width = '100%';
      cometCanvas.style.height = '100%';
      svg.attr('viewBox', `0 0 ${width} ${height}`).attr('preserveAspectRatio', 'xMidYMid meet');

      const controlReserve = compactGlobe ? 18 : 0;
      baseScale = Math.max(140, (Math.min(width, height) - controlReserve) * (compactGlobe ? 0.48 : 0.47));
      projection = d3.geoOrthographic()
        .scale(baseScale * zoomScale)
        .translate([width / 2, height / 2])
        .rotate(globeRotation)
        .clipAngle(90)
        .precision(0.3);
      pathGen = d3.geoPath(projection);
      svg.selectAll('*').remove();
      const defs = svg.append('defs');
      const glow = defs.append('radialGradient')
        .attr('id', 'traffic-map-globe-glow')
        .attr('cx', '36%')
        .attr('cy', '28%');
      glow.append('stop').attr('offset', '0%').attr('stop-color', 'rgba(35, 47, 68, 0.34)');
      glow.append('stop').attr('offset', '62%').attr('stop-color', 'rgba(10, 16, 29, 0.28)');
      glow.append('stop').attr('offset', '100%').attr('stop-color', 'rgba(2, 6, 14, 0.18)');
      const landDots = defs.append('pattern')
        .attr('id', 'traffic-map-land-dots')
        .attr('width', 5)
        .attr('height', 5)
        .attr('patternUnits', 'userSpaceOnUse');
      landDots.append('rect').attr('width', 5).attr('height', 5).attr('fill', 'rgba(255, 255, 255, 0)');
      landDots.append('circle').attr('cx', 1.8).attr('cy', 1.8).attr('r', 0.95).attr('fill', '#f97316');
      const glowFilter = defs.append('filter')
        .attr('id', 'traffic-map-route-glow')
        .attr('x', '-25%')
        .attr('y', '-25%')
        .attr('width', '150%')
        .attr('height', '150%');
      glowFilter.append('feGaussianBlur')
        .attr('stdDeviation', 2.6)
        .attr('result', 'blur');
      const merge = glowFilter.append('feMerge');
      merge.append('feMergeNode').attr('in', 'blur');
      merge.append('feMergeNode').attr('in', 'SourceGraphic');
      rootGroup = svg.append('g').attr('class', 'traffic-map-root');
      rootGroup.append('path')
        .datum({ type: 'Sphere' })
        .attr('class', 'traffic-map-globe-sphere')
        .attr('d', pathGen);
      rootGroup.append('path')
        .datum(d3.geoGraticule().step([30, 30])())
        .attr('class', 'traffic-map-globe-grid')
        .attr('d', pathGen);
      rootGroup.append('g').attr('class', 'traffic-map-countries');
      rootGroup.append('g').attr('class', 'traffic-map-arc-glows');
      rootGroup.append('g').attr('class', 'traffic-map-arc-flows');
      rootGroup.append('g').attr('class', 'traffic-map-arcs');
      rootGroup.append('g').attr('class', 'traffic-map-route-hover');
      rootGroup.append('g').attr('class', 'traffic-map-destinations');
      rootGroup.append('g').attr('class', 'traffic-map-origins');

      const maxScale = 2.8;
      zoomBehavior = d3.zoom()
        .scaleExtent([0.82, maxScale])
        .filter(e => {
          const isMobileLayout = canvasWidth < 980;
          const isUnlocked = !isMobileLayout || userUnlockedMap;
          if (!isUnlocked) return false;
          
          if (e.type === 'wheel' || e.type === 'dblclick') return true;
          
          if (e.type === 'touchstart') {
            if (e.touches && e.touches.length >= 2) {
              isPinching = true;
              return true;
            }
            return false;
          }
          if (e.type === 'touchmove') {
            return isPinching;
          }
          if (e.type === 'touchend' || e.type === 'touchcancel') {
            const wasPinching = isPinching;
            if (e.touches && e.touches.length < 2) {
              isPinching = false;
            }
            return wasPinching;
          }
          return false;
        })
        .on('zoom', e => {
          zoomScale = e.transform.k;
          projection.scale(baseScale * zoomScale);
          renderGlobeLayers();
        });

      dragBehavior = d3.drag()
        .filter(e => {
          const isMobileLayout = canvasWidth < 980;
          const isUnlocked = !isMobileLayout || userUnlockedMap;
          if (!isUnlocked) return false;
          
          if (e.touches && e.touches.length > 1) return false;
          return !e.button;
        })
        .on('start', () => {
          isDraggingGlobe = true;
          hideTooltip();
        })
        .on('drag', e => {
          globeRotation = [
            globeRotation[0] + e.dx * 0.24,
            fixedGlobeTilt,
            0,
          ];
          projection.rotate(globeRotation);
          renderGlobeLayers();
        })
        .on('end', () => {
          isDraggingGlobe = false;
        });
      svg.call(zoomBehavior).call(dragBehavior);
      updateLockStateUI();
      startGlobeRotation();
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

    function renderGlobeLayers() {
      if (!rootGroup || !projection || !pathGen) return;
      rootGroup.select('.traffic-map-globe-sphere').attr('d', pathGen);
      rootGroup.select('.traffic-map-globe-grid').attr('d', pathGen);
      renderCountries();
      if (lastData) render(lastData, { visualOnly: true });
    }

    function startGlobeRotation() {
      if (rotationTimer) rotationTimer.stop();
      let previous = performance.now();
      let lastFrame = 0;
      rotationTimer = d3.timer(now => {
        if (document.hidden || isDraggingGlobe || !projection) {
          previous = now;
          return;
        }
        if (now - lastFrame < 32) return;
        lastFrame = now;
        const elapsed = Math.min(48, now - previous);
        previous = now;
        globeRotation = [globeRotation[0] + elapsed * 0.0026, fixedGlobeTilt, 0];
        projection.rotate(globeRotation);
        renderGlobeLayers();
        drawTrafficPulses(now);
      });
    }

    function pointVisible(point) {
      if (!projection || point?.lat == null || point?.lng == null) return false;
      const center = [-globeRotation[0], -globeRotation[1]];
      return d3.geoDistance([point.lng, point.lat], center) <= Math.PI / 2;
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

    function routeSamples(src, dst) {
      const interpolator = d3.geoInterpolate([src.lng, src.lat], [dst.lng, dst.lat]);
      const samples = [];
      for (let i = 0; i <= 56; i++) {
        const t = i / 56;
        const [lng, lat] = interpolator(t);
        const projected = projection([lng, lat]);
        if (projected && pointVisible({ lat, lng })) {
          samples.push(projected);
        }
      }
      return samples;
    }

    function curvedArc(src, dst) {
      const samples = routeSamples(src, dst);
      if (samples.length < 2) return null;
      return d3.line()(samples);
    }

    function samplePulsePoint(samples, progress) {
      const f = Math.max(0, Math.min(0.999, progress)) * (samples.length - 1);
      const i = Math.floor(f);
      const frac = f - i;
      const a = samples[i];
      const b = samples[i + 1] || a;
      return {
        x: a[0] + (b[0] - a[0]) * frac,
        y: a[1] + (b[1] - a[1]) * frac,
      };
    }

    function drawTrafficPulses(now = performance.now()) {
      cometCtx.setTransform(1, 0, 0, 1, 0, 0);
      cometCtx.clearRect(0, 0, cometCanvas.width, cometCanvas.height);
      if (reducedMotion || pulseRoutes.length === 0) return;

      cometCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cometCtx.globalCompositeOperation = 'screen';
      for (const route of pulseRoutes) {
        const dots = route.dots;
        for (let i = 0; i < dots; i++) {
          const progress = ((now / route.duration) + route.phase + (i / dots)) % 1;
          const point = samplePulsePoint(route.samples, progress);
          const alpha = 0.42 + route.weight * 0.34;
          cometCtx.fillStyle = `rgba(${route.rgb.r}, ${route.rgb.g}, ${route.rgb.b}, ${alpha})`;
          cometCtx.beginPath();
          cometCtx.arc(point.x, point.y, route.size, 0, Math.PI * 2);
          cometCtx.fill();
        }
      }
      cometCtx.globalCompositeOperation = 'source-over';
      cometCtx.setTransform(1, 0, 0, 1, 0, 0);
    }

    function buildPulseRoutes(routes, originColor, maxRoute, routeWeight) {
      if (reducedMotion) {
        pulseRoutes = [];
        drawTrafficPulses();
        return;
      }
      const cap = canvasWidth < 520 ? 28 : 54;
      pulseRoutes = routes
        .slice()
        .sort((a, b) => (b.count || 0) - (a.count || 0))
        .slice(0, cap)
        .map(route => {
          const samples = routeSamples(
            { lat: route.sourceLat, lng: route.sourceLng },
            { lat: route.destinationLat, lng: route.destinationLng }
          );
          if (samples.length < 8) return null;
          const color = originColor(route.sourceCountry);
          const weight = routeWeight(route.count);
          return {
            samples,
            rgb: hexToRgb(color),
            weight,
            size: Math.max(1.15, Math.min(2.9, 1.2 + weight * 2.2)),
            duration: 2800 + (1 - weight) * 2600,
            phase: pulsePhaseByRoute.has(`${route.sourceCountry}->${route.destinationCountry}`)
              ? pulsePhaseByRoute.get(`${route.sourceCountry}->${route.destinationCountry}`)
              : pulsePhaseByRoute.set(`${route.sourceCountry}->${route.destinationCountry}`, Math.random()).get(`${route.sourceCountry}->${route.destinationCountry}`),
            dots: canvasWidth < 520 ? 1 : (route.count || 0) > maxRoute * 0.34 ? 2 : 1,
          };
        })
        .filter(Boolean);
      drawTrafficPulses();
    }

    function render(data, options = {}) {
      lastData = data;
      clearError();
      if (!rootGroup) return;

      const sources = (data.sources || []).filter(s => s.lat != null && s.lng != null);
      const destinations = (data.destinations || []).filter(d => d.lat != null && d.lng != null);
      const routes = (data.routes || []).filter(r => r.sourceLat != null && r.destinationLat != null);
      const visibleSources = sources.filter(pointVisible);
      const visibleDestinations = destinations.filter(pointVisible);
      const visibleRoutes = routes
        .filter(r => pointVisible({ lat: r.sourceLat, lng: r.sourceLng }) || pointVisible({ lat: r.destinationLat, lng: r.destinationLng }))
        .sort((a, b) => (b.count || 0) - (a.count || 0))
        .slice(0, canvasWidth < 520 ? 42 : 78);
      const isDenseRoutes = routes.length > 300;
      const viewMin = Math.max(280, Math.min(canvasWidth || 960, canvasHeight || 520));
      svgEl.parentElement?.classList.toggle('traffic-map-dense-routes', isDenseRoutes);
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
      const arcOpacity = d3.scaleSqrt().domain([1, maxRoute]).range([0.55, 0.95]);
      const routeWeight = d3.scaleSqrt().domain([1, maxRoute]).range([0.12, 1]);
      const palette = [...d3.schemeTableau10, ...d3.schemeSet2, ...d3.schemePaired];
      const originColor = d3.scaleOrdinal(palette).domain(sources.map(s => s.country));
      const routeKey = route => `${route.sourceCountry}->${route.destinationCountry}`;
      const setRouteHover = route => {
        const key = route ? routeKey(route) : null;
        rootGroup.select('.traffic-map-arc-flows')
          .selectAll('path')
          .classed('is-hovered', d => !!key && routeKey(d) === key);

        const hoverLayer = rootGroup.select('.traffic-map-route-hover');
        const points = route ? [
          {
            role: 'origin',
            color: originColor(route.sourceCountry),
            point: projection([route.sourceLng, route.sourceLat]),
            visible: pointVisible({ lat: route.sourceLat, lng: route.sourceLng }),
          },
          {
            role: 'destination',
            color: originColor(route.sourceCountry),
            point: projection([route.destinationLng, route.destinationLat]),
            visible: pointVisible({ lat: route.destinationLat, lng: route.destinationLng }),
          },
        ].filter(d => d.visible && d.point) : [];
        hoverLayer.selectAll('circle')
          .data(points, d => d.role)
          .join(
            enter => enter.append('circle')
              .attr('class', d => `traffic-map-route-endpoint traffic-map-route-endpoint-${d.role}`)
              .attr('pointer-events', 'none'),
            update => update,
            exit => exit.remove()
          )
          .attr('cx', d => d.point[0])
          .attr('cy', d => d.point[1])
          .attr('r', d => d.role === 'origin' ? 3.8 : 4.8)
          .attr('stroke', d => d.color);
      };

      const pathCache = new Map();
      const routePath = d => {
        const key = routeKey(d);
        if (!pathCache.has(key)) {
          pathCache.set(key, curvedArc({ lat: d.sourceLat, lng: d.sourceLng }, { lat: d.destinationLat, lng: d.destinationLng }));
        }
        return pathCache.get(key);
      };

      rootGroup.select('.traffic-map-arc-glows').selectAll('path').remove();

      const arcSel = rootGroup.select('.traffic-map-arcs').selectAll('path').data(visibleRoutes, r => `${r.sourceCountry}->${r.destinationCountry}`);
      arcSel.exit().remove();
      arcSel.enter().append('path')
        .attr('class', 'traffic-map-arc-path')
        .attr('fill', 'none')
        .on('mousemove', (e, d) => {
          setRouteHover(d);
          showTooltip(`<strong>${escapeHtml(countryLabel(d.sourceCountry))} → ${escapeHtml(countryLabel(d.destinationCountry))}</strong><br>${formatNumber(d.count)} queries`, e);
        })
        .on('mouseleave', () => {
          setRouteHover(null);
          hideTooltip();
        })
        .merge(arcSel)
        .attr('d', routePath)
        .style('display', d => routePath(d) ? null : 'none')
        .attr('stroke', 'transparent')
        .attr('stroke-width', d => Math.max(12, arcW(d.count) * 4))
        .attr('opacity', 0);

      const staticArcSel = rootGroup.select('.traffic-map-arc-flows').selectAll('path').data(visibleRoutes, routeKey);
      staticArcSel.exit().remove();
      staticArcSel.enter().append('path')
        .attr('class', 'traffic-map-route-static-arc')
        .attr('fill', 'none')
        .attr('pointer-events', 'none')
        .merge(staticArcSel)
        .attr('d', routePath)
        .style('display', d => routePath(d) ? null : 'none')
        .attr('stroke', d => originColor(d.sourceCountry))
        .attr('stroke-width', d => Math.max(0.48, arcW(d.count) * 0.34))
        .attr('stroke-opacity', d => Math.min(isDenseRoutes ? 0.12 : 0.24, arcOpacity(d.count) * (isDenseRoutes ? 0.15 : 0.28)));

      buildPulseRoutes(visibleRoutes, originColor, maxRoute, routeWeight);

      const destSel = rootGroup.select('.traffic-map-destinations').selectAll('circle').data(visibleDestinations, d => d.country);
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
      const srcSel = rootGroup.select('.traffic-map-origins').selectAll('g.traffic-map-origin-pin').data(visibleSources, d => d.country);
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

      if (!options.visualOnly && legendEl && legendListEl) {
        legendEl.hidden = sources.length === 0;
        legendListEl.innerHTML = sources.map(source => {
          const color = originColor(source.country);
          const label = countryLabel(source.country);
          return `<div class="traffic-map-legend-item" title="${escapeHtml(label)}"><span class="traffic-map-legend-swatch" style="background:${color}; border-radius: 50%; width: 6px; height: 6px;"></span><span class="traffic-map-legend-pair" style="font-weight: 500;">${escapeHtml(label)}</span><span class="traffic-map-legend-count" style="color: var(--accent); font-weight: 600;">${formatNumber(source.count)}</span></div>`;
        }).join('');
      }

      const destListEl = document.getElementById('traffic-map-dest-list');
      if (!options.visualOnly && destListEl) {
        destListEl.innerHTML = destinations.map(dest => {
          const label = countryLabel(dest.country);
          return `<div class="traffic-map-legend-item" title="${escapeHtml(label)}"><span class="traffic-map-legend-pair" style="font-weight: 500;">${escapeHtml(label)}</span><span class="traffic-map-legend-count" style="color: var(--accent); font-weight: 600;">${formatNumber(dest.count)}</span></div>`;
        }).join('');
      }



      if (!options.visualOnly && updatedBadge && data.updatedAt && !data.cachedAt) {
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
      socket.emit('dashboard_view_state', { trafficRange: range });
      
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

    function updateLockStateUI() {
      const isMobileLayout = canvasWidth < 980;
      const isUnlocked = !isMobileLayout || userUnlockedMap;
      
      if (toggleLockBtn) {
        toggleLockBtn.classList.toggle('unlocked', isUnlocked);
        toggleLockBtn.classList.toggle('locked', !isUnlocked);
        toggleLockBtn.setAttribute('aria-label', isUnlocked ? 'Lock map rotation' : 'Unlock map rotation');
        toggleLockBtn.setAttribute('title', isUnlocked ? 'Lock map rotation' : 'Unlock map rotation');
      }
      
      const stage = svgEl.parentElement;
      if (stage) {
        stage.classList.toggle('is-unlocked', isUnlocked);
      }

      if (svgEl) {
        svgEl.style.touchAction = isUnlocked ? 'none' : 'pan-y';
      }
    }

    if (toggleLockBtn) {
      toggleLockBtn.addEventListener('click', () => {
        userUnlockedMap = !userUnlockedMap;
        updateLockStateUI();
      });
    }

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

    return { load, ensureInitialized, isLoading: () => loadingStarted, getRange: () => currentRange };
  };
})();
