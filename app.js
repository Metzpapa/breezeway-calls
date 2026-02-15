/* breezeway-calls — call flow renderer */

(function () {
  'use strict';

  // ── Config ──
  // SHA-256 hash of the PIN. To change, run in browser console:
  //   crypto.subtle.digest('SHA-256', new TextEncoder().encode('YOUR_PIN'))
  //     .then(b => console.log(Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,'0')).join('')))
  var PIN_HASH = '15e2b0d3c33891ebb0f1ef609ec419420c20e320ce94c65fbc8c3312448eb225'; // default: "123456789"
  var LS_KEY = 'bwc_pin_ok';

  var app = document.getElementById('app');
  var indexData = null; // loaded once
  var currentLead = null;
  var currentFlow = null;
  var breadcrumb = []; // [{nodeId, label}]

  // ── Helpers ──

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'className') e.className = attrs[k];
      else if (k === 'textContent') e.textContent = attrs[k];
      else if (k === 'innerHTML') e.innerHTML = attrs[k];
      else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    });
    if (children) children.forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }

  async function sha256(str) {
    var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  function setHash(h) {
    history.pushState(null, '', '#' + h);
  }

  function getHash() {
    return location.hash.replace(/^#/, '');
  }

  // ── PIN Gate ──

  function showPinGate() {
    app.innerHTML = '';
    var gate = el('div', { id: 'pin-gate' }, [
      el('h1', { textContent: 'Enter PIN' }),
      el('input', { id: 'pin-input', type: 'password', inputmode: 'numeric', maxlength: '20', autocomplete: 'off', placeholder: '\u2022\u2022\u2022\u2022' }),
      el('div', { id: 'pin-error' })
    ]);
    app.appendChild(gate);
    var input = document.getElementById('pin-input');
    input.focus();
    input.addEventListener('keydown', async function (e) {
      if (e.key === 'Enter') {
        var hash = await sha256(input.value);
        if (hash === PIN_HASH) {
          localStorage.setItem(LS_KEY, '1');
          route();
        } else {
          document.getElementById('pin-error').textContent = 'Wrong PIN';
          input.value = '';
          input.focus();
        }
      }
    });
  }

  function checkPin() {
    return localStorage.getItem(LS_KEY) === '1';
  }

  // ── Data Loading ──

  async function loadIndex() {
    if (indexData) return indexData;
    var resp = await fetch('data/index.json');
    if (!resp.ok) throw new Error('Could not load lead index');
    indexData = await resp.json();
    return indexData;
  }

  async function loadLead(slug) {
    var resp = await fetch('data/leads/' + slug + '.json');
    if (!resp.ok) throw new Error('Lead not found: ' + slug);
    return resp.json();
  }

  // ── Search / Index View ──

  function renderSearchView(data) {
    app.innerHTML = '';
    var view = el('div', { id: 'search-view' });

    var header = el('div', { id: 'search-header' }, [
      el('h1', { textContent: 'Call Flows' }),
      el('input', { id: 'search-input', type: 'text', placeholder: 'Search by name, company, or location...' })
    ]);
    view.appendChild(header);

    var list = el('div', { id: 'search-results' });
    view.appendChild(list);
    app.appendChild(view);

    var leads = data.leads || [];

    function renderList(filtered) {
      list.innerHTML = '';
      if (filtered.length === 0) {
        list.appendChild(el('div', { className: 'no-results', textContent: 'No leads found' }));
        return;
      }

      // Group by company
      var groups = {};
      var order = [];
      filtered.forEach(function (l) {
        var key = l.company || 'Unknown';
        if (!groups[key]) { groups[key] = []; order.push(key); }
        groups[key].push(l);
      });

      order.forEach(function (company) {
        var g = el('div', { className: 'company-group' }, [
          el('div', { className: 'company-group-name', textContent: company })
        ]);
        groups[company].forEach(function (l) {
          var card = el('div', { className: 'lead-card', onClick: function () { setHash('lead/' + l.slug); route(); } }, [
            el('div', { className: 'lead-card-name', textContent: l.name }),
            el('div', { className: 'lead-card-meta', textContent: [l.title, l.location].filter(Boolean).join(' \u00b7 ') })
          ]);
          g.appendChild(card);
        });
        list.appendChild(g);
      });
    }

    renderList(leads);

    document.getElementById('search-input').addEventListener('input', function (e) {
      var q = e.target.value.toLowerCase().trim();
      if (!q) { renderList(leads); return; }
      var filtered = leads.filter(function (l) {
        return (l.name || '').toLowerCase().includes(q) ||
               (l.company || '').toLowerCase().includes(q) ||
               (l.location || '').toLowerCase().includes(q);
      });
      renderList(filtered);
    });
  }

  // ── Lead / Flow View ──

  function renderLeadView(lead) {
    currentLead = lead;
    currentFlow = lead.flow;
    breadcrumb = [];

    app.innerHTML = '';
    var view = el('div', { id: 'lead-view' });

    // Header
    var phoneDisplay = (lead.phone || '').replace(/^\+1[-\s]?/, '(').replace(/(\d{3})[-\s]?(\d{3})[-\s]?(\d{4})/, '($1) $2-$3');
    if (!phoneDisplay && lead.company_phone) {
      phoneDisplay = (lead.company_phone || '').replace(/^\+1[-\s]?/, '(').replace(/(\d{3})[-\s]?(\d{3})[-\s]?(\d{4})/, '($1) $2-$3');
    }
    var rawPhone = lead.phone || lead.company_phone || '';

    var headerChildren = [
      el('div', { className: 'lead-header-top' }, [
        el('button', { className: 'back-btn', textContent: '\u2190', onClick: function () { setHash(''); route(); } }),
        el('span', { className: 'lead-name', textContent: lead.name })
      ]),
      el('div', { className: 'lead-title', textContent: [lead.title, lead.company].filter(Boolean).join(' \u2014 ') })
    ];

    if (rawPhone) {
      headerChildren.push(el('a', { className: 'lead-phone', href: 'tel:' + rawPhone.replace(/[^\d+]/g, ''), textContent: phoneDisplay || rawPhone }));
    }

    view.appendChild(el('div', { className: 'lead-header' }, headerChildren));

    // Context panel
    if (currentFlow && currentFlow.context) {
      var panel = el('div', { className: 'context-panel open' }, [
        el('button', { className: 'context-toggle', innerHTML: '<span class="arrow">\u25b6</span> CONTEXT', onClick: function () { panel.classList.toggle('open'); } }),
        el('div', { className: 'context-body', textContent: currentFlow.context })
      ]);
      view.appendChild(panel);
    }

    // Breadcrumb container
    view.appendChild(el('div', { className: 'breadcrumb', id: 'breadcrumb' }));

    // Node container
    view.appendChild(el('div', { className: 'node', id: 'node-container' }));

    app.appendChild(view);

    // Navigate to start
    if (currentFlow && currentFlow.start && currentFlow.nodes) {
      // Check if hash already specifies a node
      var parts = getHash().split('/');
      var targetNode = parts.length >= 3 ? parts.slice(2).join('/') : currentFlow.start;
      if (!currentFlow.nodes[targetNode]) targetNode = currentFlow.start;
      navigateToNode(targetNode, true);
    } else {
      document.getElementById('node-container').appendChild(
        el('div', { className: 'error-msg', textContent: 'No call flow data available for this lead.' })
      );
    }
  }

  function navigateToNode(nodeId, isInitial) {
    var node = currentFlow.nodes[nodeId];
    if (!node) return;

    // Update breadcrumb
    if (isInitial) {
      breadcrumb = [{ id: nodeId, label: node.label }];
    } else {
      // Check if we're going back to a node already in the trail
      var existingIdx = -1;
      for (var i = 0; i < breadcrumb.length; i++) {
        if (breadcrumb[i].id === nodeId) { existingIdx = i; break; }
      }
      if (existingIdx >= 0) {
        breadcrumb = breadcrumb.slice(0, existingIdx + 1);
      } else {
        breadcrumb.push({ id: nodeId, label: node.label });
      }
    }

    // Update hash without triggering route
    var slug = currentLead.slug || '';
    history.replaceState(null, '', '#lead/' + slug + '/' + nodeId);

    // Collapse context after first navigation
    if (!isInitial) {
      var panel = document.querySelector('.context-panel');
      if (panel) panel.classList.remove('open');
    }

    renderBreadcrumb();
    renderNode(nodeId, node);
  }

  function renderBreadcrumb() {
    var bc = document.getElementById('breadcrumb');
    if (!bc) return;
    bc.innerHTML = '';

    breadcrumb.forEach(function (item, i) {
      if (i > 0) bc.appendChild(el('span', { className: 'breadcrumb-sep', textContent: '\u203a' }));
      var isLast = i === breadcrumb.length - 1;
      var btn = el('button', {
        className: 'breadcrumb-item' + (isLast ? ' current' : ''),
        textContent: item.label
      });
      if (!isLast) {
        btn.addEventListener('click', function () { navigateToNode(item.id, false); });
      }
      bc.appendChild(btn);
    });
  }

  function renderNode(nodeId, node) {
    var container = document.getElementById('node-container');
    if (!container) return;
    container.innerHTML = '';

    // Label
    container.appendChild(el('div', { className: 'node-label', textContent: node.label }));

    // Say
    container.appendChild(el('div', { className: 'node-say', textContent: node.say }));

    // Note
    if (node.note) {
      container.appendChild(el('div', { className: 'node-note', textContent: node.note }));
    }

    // Branches
    if (node.branches && node.branches.length > 0) {
      var branchContainer = el('div', { className: 'branches' });
      node.branches.forEach(function (b) {
        branchContainer.appendChild(el('button', {
          className: 'branch-btn',
          onClick: function () { navigateToNode(b.to, false); }
        }, [
          el('span', { textContent: b.label }),
          el('span', { className: 'branch-arrow', textContent: '\u203a' })
        ]));
      });
      container.appendChild(branchContainer);
    } else {
      // Terminal node
      container.appendChild(el('div', { className: 'terminal-msg', textContent: 'End of flow' }));
    }

    // Start over
    container.appendChild(el('button', {
      className: 'start-over-btn',
      textContent: 'Start Over',
      onClick: function () { navigateToNode(currentFlow.start, true); }
    }));

    // Scroll to top of node
    container.scrollIntoView({ behavior: 'instant', block: 'start' });
  }

  // ── Router ──

  async function route() {
    if (!checkPin()) { showPinGate(); return; }

    var hash = getHash();

    // Lead view: #lead/{slug} or #lead/{slug}/{nodeId}
    if (hash.startsWith('lead/')) {
      var parts = hash.split('/');
      var slug = parts[1];
      if (!slug) { showSearch(); return; }

      app.innerHTML = '<div class="loading">Loading...</div>';
      try {
        var lead = await loadLead(slug);
        lead.slug = slug;
        renderLeadView(lead);
      } catch (e) {
        app.innerHTML = '';
        app.appendChild(el('div', { className: 'error-msg', textContent: 'Could not load lead: ' + slug }));
      }
      return;
    }

    // Default: search view
    showSearch();
  }

  async function showSearch() {
    app.innerHTML = '<div class="loading">Loading...</div>';
    try {
      var data = await loadIndex();
      renderSearchView(data);
    } catch (e) {
      app.innerHTML = '';
      app.appendChild(el('div', { className: 'error-msg', textContent: 'Could not load lead index. Make sure data/index.json exists.' }));
    }
  }

  // ── Init ──

  window.addEventListener('hashchange', route);
  window.addEventListener('popstate', route);
  route();

})();
