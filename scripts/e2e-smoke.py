# End-to-end smoke test against a RUNNING stack (npm run dev:all -- --prod): registers a user, links sandbox banks, syncs, adds a card, schedules a goal, fetches a sample credit report and chats with the on-device model.
# Usage: python3 scripts/e2e-smoke.py
import json, urllib.request, urllib.parse, http.cookiejar, time, re, sys
jar = http.cookiejar.CookieJar(); op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None
nr = urllib.request.build_opener(NoRedirect)
B = 'http://localhost:3100/api'
COOKIE = {}
def call(method, path, body=None, tmo=180):
    h = {'content-type': 'application/json'} if body is not None else {}
    if COOKIE: h['cookie'] = '; '.join(f'{k}={v}' for k, v in COOKIE.items())
    req = urllib.request.Request(B + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers=h)
    def grab(resp):
        for c in resp.headers.get_all('set-cookie') or []:
            nv = c.split(';')[0]; k, _, v = nv.partition('=')
            if v: COOKIE[k] = v
    try:
        with urllib.request.urlopen(req, timeout=tmo) as r: grab(r); return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e: grab(e); return e.code, json.loads(e.read() or b'{}')
def ok(label, cond, extra=''):
    print(('PASS ' if cond else 'FAIL ') + label, extra); 
    if not cond: sys.exit(1)
email = f'e2e{int(time.time())}@example.test'
s, r = call('POST', '/auth/register', {'email': email, 'name': 'Asha Verma', 'password': 'e2e-pass-Zx81-local'}); ok('register', s == 200)
s, r = call('PATCH', '/settings', {'base_currency': 'INR'}); ok('base currency INR', s == 200, str(s) + str(r))
# --- bank links through the aggregator service (sandbox AA) ---
s, r = call('GET', '/connections/providers'); ok('providers via aggregator service', s == 200 and r['mode'] == 'sandbox', r.get('mode'))
s, r = call('POST', '/connections', {'mobile': '9876543210', 'aa_handle': 'anumati', 'months': 3}); ok('start link', s == 200 and 'approval_url' in r, str(r)[:100])
u = urllib.parse.urlparse(r['approval_url']); q = urllib.parse.parse_qs(u.query)
page = urllib.request.urlopen(r['approval_url']).read().decode(); ok('consent page renders', 'Sandbox Account Aggregator' in page)
data = urllib.parse.urlencode([('handle', q['handle'][0]), ('redirect', q['redirect'][0]), ('decision', 'approve'), ('otp', '123456'), ('acc', 'HDFC-FIP'), ('acc', 'SBI-FIP'), ('acc', 'ICICI-FIP')]).encode()
try: nr.open(urllib.request.Request(f'http://localhost:3201/sandbox-aa/approve', data=data)); loc = ''
except urllib.error.HTTPError as e: loc = e.headers.get('location', ''); ok('approve redirects back to Ledgerly', e.code == 302 and 'localhost:3100/connections' in loc, loc[:90])
time.sleep(0.5)
s, r = call('GET', '/connections'); link = r['items'][0]; ok('link is ACTIVE', link['status'] == 'ACTIVE', link['status'])
t0 = time.time(); s, r = call('POST', f"/connections/{link['id']}/sync", {}); ok('sync imports banks', s == 200 and r['created_accounts'] == 3 and r['new_transactions'] > 100, json.dumps(r)[:160])
s, r2 = call('POST', f"/connections/{link['id']}/sync", {}); ok('second sync adds nothing (idempotent)', r2['new_transactions'] == 0 and r2['already_imported'] == r['new_transactions'])
s, r = call('GET', '/connections'); ok('balances match the banks', all(a['drift'] == 0 for a in r['items'][0]['accounts']), str([a['drift'] for a in r['items'][0]['accounts']]))
s, accts = call('GET', '/accounts'); ok('3 INR accounts created', len([a for a in accts if a['currency'] == 'INR']) == 3)
s, up = call('GET', '/upi/summary'); ok('UPI payments detected from narrations (recent list is not period-limited)', len(up['recent']) >= 10 and all(r['upi_vpa'] for r in up['recent']), f"{[(r['merchant'], r['upi_vpa']) for r in up['recent'][:3]]}")
# --- cards ---
hdfc = [a for a in accts if 'HDFC' in a['name']][0]
s, r = call('POST', '/cards', {'nickname': 'HDFC Debit', 'kind': 'debit', 'network': 'rupay', 'last4': '4821', 'account_id': hdfc['id']}); ok('add card', s == 200, str(r))
s, r = call('POST', '/cards', {'nickname': '4111 1111 1111 1111', 'kind': 'debit', 'last4': '1234'}); ok('full card number rejected', s == 400, str(r)[:80])
s, cards = call('GET', '/cards'); k = cards['items'][0]; ok('card spend attributed (card narration + single card on account)', k['spent_period'] > 0 or k['spent_ytd'] > 0, f"ytd={k['spent_ytd']}")
# --- goal auto-save ---
s, g = call('POST', '/goals', {'name': 'Vacation', 'type': 'vacation', 'target_amount': 20000000}); gid = g['id']
sav = [a for a in accts if 'State Bank' in a['name']][0]; today = time.strftime('%Y-%m-%d')
s, r = call('PUT', f'/goals/{gid}/schedule', {'amount': 500000, 'cadence': 'monthly', 'next_run': today, 'from_account_id': sav['id'], 'active': True}); ok('schedule saved and executed today', s == 200, str(r)[:120])
s, goals = call('GET', '/goals'); gv = [x for x in goals if x['id'] == gid][0]; ok('goal credited on the chosen date', gv['current_amount'] == 500000 and gv['schedule']['runs'][0]['status'] == 'done', f"saved={gv['current_amount']} next={gv['schedule']['next_run']}")
# --- credit report via bureau service ---
s, r = call('POST', '/credit/fetch', {'name': 'Asha Verma', 'dob': '1990-05-17', 'pan': 'ABCPE1234F', 'mobile': '9876543210', 'consent': True}); ok('credit report fetched via bureau service', s == 200, str(r)[:100])
s, cr = call('GET', '/credit'); ok('score present, PAN not stored', 300 <= cr['latest']['score']['value'] <= 900 and 'ABCPE' not in json.dumps(cr), f"score={cr['latest']['score']['value']} sample={cr['latest']['sample']}")
s, r = call('POST', '/credit/fetch', {'name': 'Asha Verma', 'dob': '1990-05-17', 'pan': 'ABCPE1234F', 'mobile': '9876543210', 'consent': False}); ok('no consent, no report', s == 400)
# --- assistant on the local Llama ---
s, st = call('GET', '/chat/status'); ok('assistant status: on-device Llama', st['engine'] == 'llama-local' and st['external_ai'] is False, str(st)[:120])
t0 = time.time(); s, a = call('POST', '/chat', {'message': 'How many UPI payments did I make this month?'}); print('   ', a.get('reply', a)[:240].replace('\n', ' | '), f"[{a.get('engine')} {time.time()-t0:.1f}s tools={a.get('tools_used')}]")
ok('chat answered by llama with tools', s == 200 and a['engine'].startswith('llama') and a['tools_used'], '')
t0 = time.time(); s, b = call('POST', '/chat', {'message': 'and what is my credit score?', 'conversation_id': a['conversation_id']}); print('   ', b['reply'][:200].replace('\n', ' | '), f"[{time.time()-t0:.1f}s tools={b['tools_used']}]")
ok('credit score question routed to credit_report', 'credit_report' in b['tools_used'])
s, cv = call('GET', '/chat/conversations'); ok('history saved in the assistant SQLite', len(cv['items']) == 1 and cv['items'][0]['messages'] == 4, str(cv['items'][0]))
s, one = call('GET', f"/chat/conversations/{a['conversation_id']}"); ok('conversation reloads', len(one['messages']) == 4)
print('ALL E2E CHECKS PASSED', email)
