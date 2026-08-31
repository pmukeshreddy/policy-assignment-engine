const state = { companyId: localStorage.getItem('policy-company'), employees: [], selectedEmployee: null };
const $ = (selector) => document.querySelector(selector);

async function api(path, options = {}) {
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
  if (state.companyId) headers['x-company-id'] = state.companyId;
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error?.message || `Request failed (${response.status})`);
  }
  return response.status === 204 ? null : response.json();
}

function notify(message, error = false) {
  const notice = $('#notice'); notice.textContent = message; notice.className = `notice${error ? ' error' : ''}`;
  clearTimeout(notify.timer); notify.timer = setTimeout(() => notice.classList.add('hidden'), 4500);
}

async function loadCompanies() {
  const { data } = await api('/companies'); const select = $('#company');
  if (!data.length) {
    const name = prompt('Create the first company to begin:');
    if (!name) return;
    const company = await api('/companies', { method: 'POST', body: JSON.stringify({ name }) }); data.push(company);
  }
  select.innerHTML = data.map((company) => `<option value="${company.id}">${escapeHtml(company.name)}</option>`).join('');
  if (!data.some((company) => company.id === state.companyId)) state.companyId = data[0].id;
  select.value = state.companyId; localStorage.setItem('policy-company', state.companyId); await refresh();
}

async function refresh() { await Promise.all([loadEmployees(), loadPolicies(), loadRules(), loadJobs()]); }

async function loadEmployees() {
  const { data } = await api('/employees'); state.employees = data; renderEmployees();
  if (state.selectedEmployee && data.some((employee) => employee.id === state.selectedEmployee)) await selectEmployee(state.selectedEmployee);
}
function renderEmployees() {
  const query = $('#employee-search').value.toLowerCase();
  $('#employee-list').innerHTML = state.employees.filter((employee) => `${employee.display_name} ${employee.external_id}`.toLowerCase().includes(query)).map((employee) =>
    `<button class="employee-item ${employee.id === state.selectedEmployee ? 'active' : ''}" data-id="${employee.id}"><span><strong>${escapeHtml(employee.display_name)}</strong><small>${escapeHtml(employee.department || employee.employment_type || employee.external_id)}</small></span>${employee.location ? `<i class="pill">${escapeHtml(employee.location)}</i>` : ''}</button>`).join('') || '<div class="empty">No employees found.</div>';
  document.querySelectorAll('.employee-item').forEach((button) => button.addEventListener('click', () => selectEmployee(button.dataset.id)));
}
async function selectEmployee(id) {
  state.selectedEmployee = id; renderEmployees();
  const [employee, assignments] = await Promise.all([api(`/employees/${id}`), api(`/employees/${id}/assignments`)]);
  const facts = [employee.location, employee.department, employee.employment_type, employee.is_manager ? 'Manager' : null, ...(employee.groups || []).map((g) => g.name)].filter(Boolean);
  $('#employee-detail').className = 'panel'; $('#employee-detail').innerHTML = `<div class="employee-header"><div><h2>${escapeHtml(employee.display_name)}</h2><p>${escapeHtml(employee.email || employee.external_id)}</p></div><span class="pill">v${employee.version}</span></div><div class="facts">${facts.map((fact) => `<span class="fact">${escapeHtml(fact)}</span>`).join('')}</div><h3>Current policies</h3><div class="policies">${assignments.data.map((assignment) => `<div class="policy"><div><strong>${escapeHtml(assignment.policy_name)}</strong><small>${escapeHtml(assignment.category_name)} · effective ${assignment.effective_from.slice(0,10)}</small></div><button data-why="${assignment.assignment_id}">Why?</button></div>`).join('') || '<div class="empty">No policies currently resolve for this employee.</div>'}</div>`;
  document.querySelectorAll('[data-why]').forEach((button) => button.addEventListener('click', () => explain(id, button.dataset.why)));
}
async function explain(employeeId, assignmentId) {
  const data = await api(`/employees/${employeeId}/assignments/${assignmentId}/explanation`);
  const winner = data.decision.winningCandidate || {};
  $('#why-content').innerHTML = `<h3>${escapeHtml(data.assignment.policyName)}</h3><p>${escapeHtml(data.decision.summary)}</p><div class="facts"><span class="fact">Source: ${escapeHtml(winner.source || 'unknown')}</span><span class="fact">Priority: ${winner.priority ?? '—'}</span><span class="fact">Evaluated: ${escapeHtml(data.decision.evaluatedOn)}</span></div><h4>Condition evaluation</h4><div class="trace">${escapeHtml(JSON.stringify(winner.trace || data.allCandidates, null, 2))}</div>${data.decision.competingCandidates.length ? `<h4>Rejected competitors</h4><div class="trace">${escapeHtml(JSON.stringify(data.decision.competingCandidates, null, 2))}</div>` : ''}`;
  $('#why-dialog').showModal();
}

async function loadPolicies() { const { data } = await api('/policies'); $('#rule-form [name=policyId]').innerHTML = data.map((p) => `<option value="${p.id}">${escapeHtml(p.name)} (${escapeHtml(p.category_key)})</option>`).join(''); }
async function loadRules() { const { data } = await api('/rules'); $('#rule-list').innerHTML = `<table><thead><tr><th>Rule</th><th>Version</th><th>Policy</th><th>Priority</th><th>Status</th></tr></thead><tbody>${data.map((r) => `<tr><td>${escapeHtml(r.key)}</td><td>v${r.version}</td><td>${escapeHtml(r.policy_key)}</td><td>${r.priority}</td><td><span class="status ${r.status.toLowerCase()}">${r.status}</span></td></tr>`).join('')}</tbody></table>`; }
async function loadJobs() { if (!state.companyId) return; const { data } = await api('/reconciliation/jobs'); $('#job-list').innerHTML = `<table><thead><tr><th>Event</th><th>Scope</th><th>Status</th><th>Attempts</th><th>Created</th></tr></thead><tbody>${data.map((job) => `<tr><td>${escapeHtml(job.event_type)}</td><td>${job.scope}</td><td><span class="status ${job.status.toLowerCase()}">${job.status}</span>${job.last_error ? `<small>${escapeHtml(job.last_error)}</small>` : ''}</td><td>${job.attempts}</td><td>${new Date(job.created_at).toLocaleString()}</td></tr>`).join('')}</tbody></table>`; }

function rulePayload() {
  const form = new FormData($('#rule-form')); const field = form.get('field'); const operator = form.get('operator'); let value = form.get('value');
  if (field === 'tenure_days') value = Number(value); else if (field === 'is_manager') value = value === 'true'; else if (operator === 'IN') value = String(value).split(',').map((item) => item.trim());
  return { key: form.get('key'), policyId: form.get('policyId'), priority: Number(form.get('priority')), enabled: true, validFrom: form.get('validFrom'), validTo: null, condition: { type:'comparison', fact: field === 'tenure_days' ? { kind:'tenure_days' } : { kind:'employee', field }, operator, value } };
}
async function previewRule() { const result = await api('/rules/preview', { method:'POST', body:JSON.stringify(rulePayload()) }); $('#preview-results').className = 'panel'; $('#preview-results').innerHTML = `<div class="metrics"><div class="metric"><strong>${result.affectedEmployees}</strong><small>Affected employees</small></div><div class="metric"><strong>+${result.assignmentsAdded}</strong><small>Assignments added</small></div><div class="metric"><strong>−${result.assignmentsRemoved}</strong><small>Assignments removed</small></div></div><div class="examples"><h3>Representative changes</h3><ul>${result.examples.map((item) => `<li><strong>${escapeHtml(item.displayName)}</strong>: ${item.beforePolicyIds.length} → ${item.afterPolicyIds.length} policies</li>`).join('') || '<li>No assignment changes.</li>'}</ul><small>${result.unchangedEmployees} employees unchanged; ${result.employeesEvaluated} evaluated exactly.</small></div>`; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char])); }

document.querySelectorAll('.nav').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('.nav,.view').forEach((item) => item.classList.remove('active')); button.classList.add('active'); $(`#${button.dataset.view}`).classList.add('active'); if (button.dataset.view === 'jobs') loadJobs(); }));
$('#company').addEventListener('change', async (event) => { state.companyId = event.target.value; state.selectedEmployee = null; localStorage.setItem('policy-company', state.companyId); await refresh(); });
$('#employee-search').addEventListener('input', renderEmployees); $('#new-employee').addEventListener('click', () => $('#employee-dialog').showModal());
$('#employee-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.target); const payload = Object.fromEntries([...form].filter(([,v]) => v !== '')); payload.isManager = form.has('isManager'); try { await api('/employees', { method:'POST', body:JSON.stringify(payload) }); $('#employee-dialog').close(); event.target.reset(); notify('Employee created; reconciliation was queued.'); await loadEmployees(); } catch (error) { notify(error.message, true); } });
$('#rule-form [name=validFrom]').value = new Date().toISOString().slice(0,10); $('#preview-rule').addEventListener('click', () => previewRule().catch((e) => notify(e.message,true)));
$('#rule-form').addEventListener('submit', async (event) => { event.preventDefault(); try { await api('/rules', { method:'POST', body:JSON.stringify({...rulePayload(),publish:true}) }); notify('Rule published and impact reconciliation queued.'); await Promise.all([loadRules(),loadJobs()]); } catch(error) { notify(error.message,true); } });
$('#full-reconcile').addEventListener('click', async () => { await api('/reconciliation/trigger',{method:'POST',body:'{}'}); notify('Full reconciliation queued.'); await loadJobs(); });
loadCompanies().catch((error) => notify(error.message, true));
