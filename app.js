/* breezeway-calls — call flow renderer + inline editor */

(function () {
  'use strict';

  // ── Config ──
  var PIN_HASH = '15e2b0d3c33891ebb0f1ef609ec419420c20e320ce94c65fbc8c3312448eb225'; // default: "123456789"
  var LS_KEY = 'bwc_pin_ok';
  var GH_TOKEN_KEY = 'bwc_gh_token';
  var GH_OWNER = 'Metzpapa';
  var GH_REPO = 'breezeway-calls';

  var app = document.getElementById('app');
  var indexData = null;
  var currentLead = null;
  var currentFlow = null;
  var currentSlug = null;
  var breadcrumb = [];
  var editMode = false;
  var dirty = false; // tracks unsaved changes

  // ── Helpers ──

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'className') e.className = attrs[k];
      else if (k === 'textContent') e.textContent = attrs[k];
      else if (k === 'innerHTML') e.innerHTML = attrs[k];
      else if (k === 'value') e.value = attrs[k];
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

  function getGhToken() {
    return localStorage.getItem(GH_TOKEN_KEY) || '';
  }

  function setGhToken(token) {
    localStorage.setItem(GH_TOKEN_KEY, token);
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
    var resp = await fetch('data/leads/' + slug + '.json?t=' + Date.now());
    if (!resp.ok) throw new Error('Lead not found: ' + slug);
    return resp.json();
  }

  // ── GitHub Save ──

  async function saveToGitHub(slug, leadData) {
    var token = getGhToken();
    if (!token) throw new Error('No GitHub token configured');

    var path = 'data/leads/' + slug + '.json';
    var apiUrl = 'https://api.github.com/repos/' + GH_OWNER + '/' + GH_REPO + '/contents/' + path;

    // Get current file SHA (needed for update)
    var getResp = await fetch(apiUrl, {
      headers: { 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github.v3+json' }
    });
    var sha = null;
    if (getResp.ok) {
      var existing = await getResp.json();
      sha = existing.sha;
    }

    var content = btoa(unescape(encodeURIComponent(JSON.stringify(leadData, null, 2))));
    var body = {
      message: 'Update call flow: ' + (leadData.name || slug),
      content: content
    };
    if (sha) body.sha = sha;

    var putResp = await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        'Authorization': 'token ' + token,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!putResp.ok) {
      var err = await putResp.json();
      throw new Error(err.message || 'GitHub API error');
    }

    return putResp.json();
  }

  // ── Token Setup Modal ──

  function showTokenSetup(onDone) {
    var overlay = el('div', { className: 'modal-overlay' });
    var modal = el('div', { className: 'modal' }, [
      el('div', { className: 'modal-title', textContent: 'GitHub Token' }),
      el('div', { className: 'modal-desc', textContent: 'Enter a GitHub personal access token with repo scope. This is stored locally in your browser.' }),
      el('input', { id: 'token-input', type: 'password', className: 'modal-input', placeholder: 'ghp_...', value: getGhToken() }),
      el('div', { className: 'modal-buttons' }, [
        el('button', { className: 'modal-btn modal-btn-cancel', textContent: 'Cancel', onClick: function () { overlay.remove(); } }),
        el('button', { className: 'modal-btn modal-btn-save', textContent: 'Save', onClick: function () {
          var val = document.getElementById('token-input').value.trim();
          if (val) {
            setGhToken(val);
            overlay.remove();
            if (onDone) onDone();
          }
        }})
      ])
    ]);
    overlay.appendChild(modal);
    app.appendChild(overlay);
    document.getElementById('token-input').focus();
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

      var groups = {};
      var order = [];
      filtered.forEach(function (l) {
        var key = l.company || 'General';
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
    currentSlug = lead.slug;
    breadcrumb = [];
    editMode = false;
    dirty = false;

    app.innerHTML = '';
    var view = el('div', { id: 'lead-view' });

    // Header
    var phoneDisplay = (lead.phone || '').replace(/^\+1[-\s]?/, '(').replace(/(\d{3})[-\s]?(\d{3})[-\s]?(\d{4})/, '($1) $2-$3');
    if (!phoneDisplay && lead.company_phone) {
      phoneDisplay = (lead.company_phone || '').replace(/^\+1[-\s]?/, '(').replace(/(\d{3})[-\s]?(\d{3})[-\s]?(\d{4})/, '($1) $2-$3');
    }
    var rawPhone = lead.phone || lead.company_phone || '';

    var headerTopChildren = [
      el('button', { className: 'back-btn', textContent: '\u2190', onClick: function () {
        if (dirty && !confirm('You have unsaved changes. Leave anyway?')) return;
        editMode = false; dirty = false; setHash(''); route();
      }}),
      el('span', { className: 'lead-name', textContent: lead.name })
    ];

    // Edit toggle button
    var editBtn = el('button', { className: 'edit-toggle-btn', textContent: '\u270e', onClick: function () {
      if (!editMode) {
        if (!getGhToken()) {
          showTokenSetup(function () { toggleEdit(); });
        } else {
          toggleEdit();
        }
      } else {
        toggleEdit();
      }
    }});
    headerTopChildren.push(editBtn);

    var headerChildren = [
      el('div', { className: 'lead-header-top' }, headerTopChildren),
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
        el('div', { className: 'context-body', id: 'context-body', textContent: currentFlow.context })
      ]);
      view.appendChild(panel);
    }

    // Edit toolbar (hidden by default)
    var toolbar = el('div', { className: 'edit-toolbar hidden', id: 'edit-toolbar' }, [
      el('span', { className: 'edit-toolbar-label', textContent: 'EDITING' }),
      el('button', { className: 'edit-save-btn', id: 'save-btn', textContent: 'Save', onClick: handleSave }),
      el('button', { className: 'edit-cancel-btn', textContent: 'Cancel', onClick: function () { toggleEdit(); } }),
      el('button', { className: 'edit-token-btn', textContent: '\u2699', onClick: function () { showTokenSetup(); } })
    ]);
    view.appendChild(toolbar);

    // Save status
    view.appendChild(el('div', { className: 'save-status hidden', id: 'save-status' }));

    // Breadcrumb container
    view.appendChild(el('div', { className: 'breadcrumb', id: 'breadcrumb' }));

    // Node container
    view.appendChild(el('div', { className: 'node', id: 'node-container' }));

    app.appendChild(view);

    // Navigate to start
    if (currentFlow && currentFlow.start && currentFlow.nodes) {
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

  function toggleEdit() {
    editMode = !editMode;
    var toolbar = document.getElementById('edit-toolbar');
    var editBtn = document.querySelector('.edit-toggle-btn');
    if (toolbar) toolbar.classList.toggle('hidden', !editMode);
    if (editBtn) editBtn.classList.toggle('active', editMode);

    if (!editMode && dirty) {
      if (!confirm('Discard unsaved changes?')) {
        editMode = true;
        if (toolbar) toolbar.classList.remove('hidden');
        if (editBtn) editBtn.classList.add('active');
        return;
      }
      // Reload to discard
      dirty = false;
      route();
      return;
    }

    // Re-render current node in edit/view mode
    var hash = getHash();
    var parts = hash.split('/');
    var nodeId = parts.length >= 3 ? parts.slice(2).join('/') : (currentFlow ? currentFlow.start : null);
    if (nodeId && currentFlow && currentFlow.nodes[nodeId]) {
      renderNode(nodeId, currentFlow.nodes[nodeId]);
    }

    // Make context editable
    var ctxBody = document.getElementById('context-body');
    if (ctxBody) {
      if (editMode) {
        ctxBody.setAttribute('contenteditable', 'true');
        ctxBody.classList.add('editable');
        ctxBody.addEventListener('input', function () {
          currentFlow.context = ctxBody.textContent;
          dirty = true;
          updateSaveBtn();
        });
      } else {
        ctxBody.removeAttribute('contenteditable');
        ctxBody.classList.remove('editable');
      }
    }
  }

  function updateSaveBtn() {
    var btn = document.getElementById('save-btn');
    if (btn) btn.textContent = dirty ? 'Save *' : 'Save';
  }

  async function handleSave() {
    if (!dirty) return;
    var btn = document.getElementById('save-btn');
    var status = document.getElementById('save-status');
    if (btn) { btn.textContent = 'Saving...'; btn.disabled = true; }
    if (status) { status.textContent = ''; status.classList.remove('hidden', 'save-error', 'save-ok'); }

    try {
      // Rebuild lead data with updated flow
      var leadData = JSON.parse(JSON.stringify(currentLead));
      leadData.flow = currentFlow;
      delete leadData.slug;

      await saveToGitHub(currentSlug, leadData);

      dirty = false;
      if (btn) { btn.textContent = 'Save'; btn.disabled = false; }
      if (status) { status.textContent = 'Saved! Site will update in ~30s.'; status.classList.remove('hidden', 'save-error'); status.classList.add('save-ok'); }
      setTimeout(function () { if (status) status.classList.add('hidden'); }, 4000);
    } catch (e) {
      if (btn) { btn.textContent = 'Save *'; btn.disabled = false; }
      if (status) { status.textContent = 'Error: ' + e.message; status.classList.remove('hidden', 'save-ok'); status.classList.add('save-error'); }
    }
  }

  // ── Node Navigation ──

  function navigateToNode(nodeId, isInitial) {
    var node = currentFlow.nodes[nodeId];
    if (!node) return;

    if (isInitial) {
      breadcrumb = [{ id: nodeId, label: node.label }];
    } else {
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

    var slug = currentLead.slug || '';
    history.replaceState(null, '', '#lead/' + slug + '/' + nodeId);

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

  // ── Node Rendering ──

  function renderNode(nodeId, node) {
    var container = document.getElementById('node-container');
    if (!container) return;
    container.innerHTML = '';

    if (editMode) {
      renderNodeEdit(container, nodeId, node);
    } else {
      renderNodeView(container, nodeId, node);
    }
  }

  function renderNodeView(container, nodeId, node) {
    container.appendChild(el('div', { className: 'node-label', textContent: node.label }));
    container.appendChild(el('div', { className: 'node-say', textContent: node.say }));

    if (node.note) {
      container.appendChild(el('div', { className: 'node-note', textContent: node.note }));
    }

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
      container.appendChild(el('div', { className: 'terminal-msg', textContent: 'End of flow' }));
    }

    container.appendChild(el('button', {
      className: 'start-over-btn',
      textContent: 'Start Over',
      onClick: function () { navigateToNode(currentFlow.start, true); }
    }));

    container.scrollIntoView({ behavior: 'instant', block: 'start' });
  }

  function renderNodeEdit(container, nodeId, node) {
    // Label (editable)
    var labelInput = el('input', { className: 'edit-input edit-label-input', value: node.label, placeholder: 'STAGE LABEL' });
    labelInput.addEventListener('input', function () { node.label = labelInput.value; dirty = true; updateSaveBtn(); });
    container.appendChild(labelInput);

    // Say (editable textarea)
    var sayArea = el('textarea', { className: 'edit-textarea edit-say-area', placeholder: 'What to say...' });
    sayArea.value = node.say || '';
    sayArea.addEventListener('input', function () { node.say = sayArea.value; dirty = true; updateSaveBtn(); autoResize(sayArea); });
    container.appendChild(sayArea);
    setTimeout(function () { autoResize(sayArea); }, 0);

    // Note (editable textarea)
    var noteArea = el('textarea', { className: 'edit-textarea edit-note-area', placeholder: 'Coaching note (not spoken)...' });
    noteArea.value = node.note || '';
    noteArea.addEventListener('input', function () { node.note = noteArea.value; dirty = true; updateSaveBtn(); autoResize(noteArea); });
    container.appendChild(noteArea);
    setTimeout(function () { autoResize(noteArea); }, 0);

    // Branches
    var branchSection = el('div', { className: 'edit-branches' });
    var branchHeader = el('div', { className: 'edit-section-header' }, [
      el('span', { textContent: 'Branches' }),
      el('button', { className: 'edit-add-btn', textContent: '+ Add', onClick: function () {
        // Add a new branch
        if (!node.branches) node.branches = [];
        var newBranch = { label: 'New response', to: nodeId }; // points to self by default
        node.branches.push(newBranch);
        dirty = true; updateSaveBtn();
        renderNode(nodeId, node);
      }})
    ]);
    branchSection.appendChild(branchHeader);

    if (node.branches && node.branches.length > 0) {
      node.branches.forEach(function (b, idx) {
        var row = el('div', { className: 'edit-branch-row' });

        var labelIn = el('input', { className: 'edit-input edit-branch-label', value: b.label, placeholder: 'Response label' });
        labelIn.addEventListener('input', function () { b.label = labelIn.value; dirty = true; updateSaveBtn(); });
        row.appendChild(labelIn);

        // Target node selector
        var selectEl = el('select', { className: 'edit-select' });
        Object.keys(currentFlow.nodes).forEach(function (nid) {
          var opt = el('option', { value: nid, textContent: nid });
          if (nid === b.to) opt.selected = true;
          selectEl.appendChild(opt);
        });
        selectEl.addEventListener('change', function () { b.to = selectEl.value; dirty = true; updateSaveBtn(); });
        row.appendChild(selectEl);

        // Delete branch button
        var delBtn = el('button', { className: 'edit-del-btn', textContent: '\u00d7', onClick: function () {
          node.branches.splice(idx, 1);
          dirty = true; updateSaveBtn();
          renderNode(nodeId, node);
        }});
        row.appendChild(delBtn);

        branchSection.appendChild(row);
      });
    }
    container.appendChild(branchSection);

    // Node management
    var mgmt = el('div', { className: 'edit-node-mgmt' }, [
      el('span', { className: 'edit-node-id', textContent: 'Node: ' + nodeId }),
      el('button', { className: 'edit-add-node-btn', textContent: '+ New Node', onClick: function () {
        var newId = prompt('New node ID (snake_case):');
        if (!newId || currentFlow.nodes[newId]) {
          if (currentFlow.nodes[newId]) alert('Node "' + newId + '" already exists');
          return;
        }
        currentFlow.nodes[newId] = { label: 'NEW NODE', say: '', note: '', branches: [] };
        dirty = true; updateSaveBtn();
        navigateToNode(newId, false);
      }})
    ]);
    container.appendChild(mgmt);

    // Navigate buttons
    container.appendChild(el('div', { className: 'branches' }));
    if (node.branches && node.branches.length > 0) {
      var navBranches = el('div', { className: 'branches edit-nav-branches' });
      node.branches.forEach(function (b) {
        navBranches.appendChild(el('button', {
          className: 'branch-btn',
          onClick: function () { navigateToNode(b.to, false); }
        }, [
          el('span', { textContent: b.label }),
          el('span', { className: 'branch-arrow', textContent: '\u203a' })
        ]));
      });
      container.appendChild(navBranches);
    }

    container.appendChild(el('button', {
      className: 'start-over-btn',
      textContent: 'Start Over',
      onClick: function () { navigateToNode(currentFlow.start, true); }
    }));

    container.scrollIntoView({ behavior: 'instant', block: 'start' });
  }

  function autoResize(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  }

  // ── Router ──

  async function route() {
    if (!checkPin()) { showPinGate(); return; }

    var hash = getHash();

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
