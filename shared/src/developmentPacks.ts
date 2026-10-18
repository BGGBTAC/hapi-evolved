import {
    DEVELOPMENT_CONTRACT_VERSION, DEVELOPMENT_EFFECTS, DEVELOPMENT_HELPER_BIN, DevelopmentPackSchema, developmentApplies, developmentContentHash,
    type DevelopmentModeCatalog, type DevelopmentModeCatalogEntry, type DevelopmentPack, type DevelopmentPackInput, type DevelopmentSettings, type DevelopmentSource,
    type DevelopmentTopic, type SpecializedDevelopmentMode,
} from './evolvedDevelopment'

/**
 * Bundled development handbooks. Original curated summaries with the official
 * source each statement was checked against (2026-10-17). They are reference
 * data for agents and people, available without Graph Memory, indexing or
 * network access. Project-specific learnings belong in project Memory.
 */

const VERIFIED = '2026-10-17'
const HELPER = DEVELOPMENT_HELPER_BIN
const src = (title: string, url: string, version?: string): DevelopmentSource => ({ title, url, verifiedAt: VERIFIED, ...(version ? { version } : {}) })
const odooDoc = (major: 19 | 20, path: string, title: string) => src(`${title} (Odoo ${major}.0)`, `https://www.odoo.com/documentation/${major}.0/${path}`, `${major}.0`)
const bothOdoo = (path: string, title: string) => [odooDoc(19, path, title), odooDoc(20, path, title)]

// ------------------------------------------------------------------ Odoo

const odooTopics: DevelopmentTopic[] = [
    {
        id: 'odoo-versions', title: 'Odoo 19 and 20: versions and runtime minimums', tags: ['version', 'python', 'postgresql'], appliesTo: { odooMajors: [19, 20] },
        summary: 'Both 19.0 and 20.0 are final releases. 19 needs Python >= 3.10 and PostgreSQL >= 13; 20 needs Python >= 3.12 and PostgreSQL >= 16. Both currently declare Python 3.14 as maximum.',
        body: [
            'Odoo 19.0 and 20.0 are both released (release.py declares them FINAL); neither is a preview. Treat the configured major as the target and never substitute master or the other major.',
            '- Odoo 19: Python 3.10 or newer, PostgreSQL 13 or newer.',
            '- Odoo 20: Python 3.12 or newer, PostgreSQL 16 or newer.',
            '- Both branches currently declare Python 3.14 as the highest supported interpreter.',
            'The authoritative values are the version constants in odoo/release.py of the checked-out branch. When the local source checkout exists, its release.py and requirements.txt win over this summary and over general model memory.',
            'Enterprise is an additional addons path from authorised Enterprise source; Community source alone does not contain Enterprise modules. HAPI never clones Enterprise automatically.',
        ].join('\n'),
        sources: [src('odoo/release.py (19.0)', 'https://github.com/odoo/odoo/blob/19.0/odoo/release.py', '19.0'), src('odoo/release.py (20.0)', 'https://github.com/odoo/odoo/blob/20.0/odoo/release.py', '20.0'), odooDoc(20, 'administration/on_premise/source.html', 'Source install')],
    },
    {
        id: 'odoo-runtime-19', title: 'Local Odoo 19 runtime from source', tags: ['setup', 'runtime', 'postgresql'], appliesTo: { odooMajors: [19] },
        summary: 'Odoo 19 runs from the public 19.0 branch in a project venv (Python >= 3.10) against a local PostgreSQL >= 13 cluster reachable only through a Unix socket.',
        body: [
            'A reproducible local runtime for an Odoo 19 project consists of:',
            '1. The public Community source, branch 19.0, checked out into the project toolchain directory (outside the module repository).',
            '2. A Python virtual environment (Python 3.10 or newer) with the requirements.txt of that checkout installed.',
            '3. A PostgreSQL 13+ cluster owned by the runner user, listening on a Unix socket in a private directory and not on TCP.',
            '4. Disposable test databases named hapi_test_<slug>. Never point tests at a shared or production database.',
            'Addons path order: the repository addons directories configured for the project, then the source addons directory. The odoo/addons directory of the source is included automatically.',
            'Record the checked-out commit (git rev-parse HEAD) so test results can be correlated with the exact source revision.',
        ].join('\n'),
        sources: [odooDoc(19, 'administration/on_premise/source.html', 'Source install'), odooDoc(19, 'developer/reference/cli.html', 'Command-line interface'), src('odoo/release.py (19.0)', 'https://github.com/odoo/odoo/blob/19.0/odoo/release.py', '19.0')],
    },
    {
        id: 'odoo-runtime-20', title: 'Local Odoo 20 runtime from source', tags: ['setup', 'runtime', 'postgresql'], appliesTo: { odooMajors: [20] },
        summary: 'Odoo 20 runs from the public 20.0 branch in a project venv (Python >= 3.12) against a local PostgreSQL >= 16 cluster reachable only through a Unix socket.',
        body: [
            'A reproducible local runtime for an Odoo 20 project consists of:',
            '1. The public Community source, branch 20.0, checked out into the project toolchain directory (outside the module repository).',
            '2. A Python virtual environment (Python 3.12 or newer; 3.13 from the development runner image qualifies) with the requirements.txt of that checkout installed.',
            '3. A PostgreSQL 16+ cluster owned by the runner user (PostgreSQL 17 from the development runner image qualifies), Unix socket only.',
            '4. Disposable test databases named hapi_test_<slug>.',
            'The raised minimums are the main runtime difference from 19: an interpreter or server that works for 19 (Python 3.10/3.11, PostgreSQL 13-15) does not satisfy 20.',
            'Check the source install guide of 20.0 for system packages; do not copy package lists from older guides.',
        ].join('\n'),
        sources: [odooDoc(20, 'administration/on_premise/source.html', 'Source install'), odooDoc(20, 'developer/reference/cli.html', 'Command-line interface'), src('odoo/release.py (20.0)', 'https://github.com/odoo/odoo/blob/20.0/odoo/release.py', '20.0')],
    },
    {
        id: 'odoo-module-manifest-19', title: 'Module structure and __manifest__.py (Odoo 19)', tags: ['module', 'manifest', 'data'], appliesTo: { odooMajors: [19] },
        summary: 'A 19.0 module is a Python package with a literal-dict __manifest__.py (name, version 19.0.x.y.z, depends, data, assets, license). Data files load in list order; access rights live in security/ir.model.access.csv.',
        body: [
            'Every addon is a directory with __init__.py and __manifest__.py. The manifest is a single Python dict literal; tools (including HAPI inspection) read it with a literal parser and never import it.',
            'Important keys: name, version, depends (modules installed first; at least base), data (XML/CSV loaded on install and update, in list order), demo, assets (bundle name -> files), license, installable, application, auto_install, external_dependencies (python/bin), optional hooks.',
            'Version convention: 19.0.<x>.<y>.<z>. A version whose series is not 19.0 is a strong sign that the module was not ported.',
            'Order matters: group definitions (security/*.xml) and security/ir.model.access.csv are usually listed before the views and menus that reference them. A file on disk but missing from data is never loaded.',
            'Increasing the module version is what makes migration scripts in migrations/<version>/ run during an update.',
        ].join('\n'),
        sources: [odooDoc(19, 'developer/reference/backend/module.html', 'Module manifests'), src('crm/security/ir.model.access.csv (19.0)', 'https://github.com/odoo/odoo/blob/19.0/addons/crm/security/ir.model.access.csv', '19.0')],
    },
    {
        id: 'odoo-module-manifest-20', title: 'Module structure and __manifest__.py (Odoo 20)', tags: ['module', 'manifest', 'data'], appliesTo: { odooMajors: [20] },
        summary: 'A 20.0 module is a Python package with a literal-dict __manifest__.py (version 20.0.x.y.z). Access control is declared in security/ir.access.csv (model ir.access), not in ir.model.access.csv.',
        body: [
            'Every addon is a directory with __init__.py and __manifest__.py. The manifest is a single Python dict literal; tools (including HAPI inspection) read it with a literal parser and never import it.',
            'Important keys: name, version, depends, data (XML/CSV loaded on install and update, in list order), demo, assets, license, installable, application, auto_install, external_dependencies, optional hooks.',
            'Version convention: 20.0.<x>.<y>.<z>. A 19.0.* version means the module has not been ported.',
            'Access control: list security/ir.access.csv in data. Odoo 20.0 has no ir.model.access or ir.rule model; a 19-style ir.model.access.csv or ir.rule records will fail to load. Groups referenced by the CSV must be defined earlier or in a dependency (core crm defines its groups in security/crm_security.xml and lists security/ir.access.csv later in data).',
            'Increasing the module version is what makes migration scripts in migrations/<version>/ run during an update.',
        ].join('\n'),
        sources: [src('crm/__manifest__.py (20.0)', 'https://github.com/odoo/odoo/blob/20.0/addons/crm/__manifest__.py', '20.0'), src('crm/security/ir.access.csv (20.0)', 'https://raw.githubusercontent.com/odoo/odoo/20.0/addons/crm/security/ir.access.csv', '20.0'), src('base/models/ir_access.py (20.0)', 'https://raw.githubusercontent.com/odoo/odoo/20.0/odoo/addons/base/models/ir_access.py', '20.0')],
    },
    {
        id: 'odoo-orm', title: 'ORM essentials: models, inheritance, computed fields', tags: ['orm', 'python', 'models'], appliesTo: { odooMajors: [19, 20] },
        summary: 'Models declare fields on classes; _inherit extends existing models, computed fields declare dependencies with @api.depends, constraints use @api.constrains, and record sets are batch-oriented.',
        body: [
            '- _name defines a new model; _inherit with the same model extends it in place; _inherit with a new _name copies fields into a new model; _inherits delegates to a parent record.',
            '- Computed fields: compute method plus @api.depends listing every field read; store=True persists and makes the field searchable; compute methods must assign a value for every record in self.',
            '- Constraints: @api.constrains raises ValidationError; SQL constraints for uniqueness-type rules.',
            '- Create overrides should accept lists of values (@api.model_create_multi) and stay batch-safe; avoid per-record queries in loops.',
            '- Environment: self.env.user, self.env.company, with_company, with_context; sudo() bypasses access checks (ir.model.access/ir.rule in 19.0, ir.access in 20.0) and needs a justified, narrow use.',
            'Before relying on a method signature, read it in the checked-out source of the configured major; examples from older versions may not match.',
        ].join('\n'),
        sources: bothOdoo('developer/reference/backend/orm.html', 'ORM API'),
    },
    {
        id: 'odoo-security-19', title: 'Access rights, record rules and multi-company (Odoo 19)', tags: ['security', 'acl', 'record-rules'], appliesTo: { odooMajors: [19] },
        summary: 'In 19.0 every new model needs access rights (ir.model.access via security/ir.model.access.csv); record rules (ir.rule) restrict rows by domain; check_access() is the API.',
        body: [
            'Access rights: security/ir.model.access.csv with header id,name,model_id:id,group_id:id,perm_read,perm_write,perm_create,perm_unlink. model_id:id is the model XML id (e.g. model_crm_lead). A model without any access right is unusable for normal users.',
            'Record rules (ir.rule): domain-based row filters per model; global rules (no group) intersect, group rules of one user are unioned.',
            'Multi-company: company-dependent records use company_id with a company record rule; relational fields can declare check_company so linked records belong to compatible companies.',
            'API: records.check_access(operation) / has_access(operation) / _filtered_access(operation). check_access_rights() and check_access_rule() still exist in 19.0 but are deprecated since 18.0.',
            'Tests should exercise permissions with a non-admin user (with_user) rather than the superuser, otherwise rules are never evaluated. Never weaken a rule to make a test pass.',
        ].join('\n'),
        sources: [odooDoc(19, 'developer/reference/backend/security.html', 'Security in Odoo'), src('base/models/ir_rule.py (19.0)', 'https://github.com/odoo/odoo/blob/19.0/odoo/addons/base/models/ir_rule.py', '19.0'), src('crm/security/ir.model.access.csv (19.0)', 'https://github.com/odoo/odoo/blob/19.0/addons/crm/security/ir.model.access.csv', '19.0')],
    },
    {
        id: 'odoo-security-20', title: 'Access control with ir.access (Odoo 20)', tags: ['security', 'acl', 'ir-access'], appliesTo: { odooMajors: [20] },
        summary: 'Odoo 20.0 replaces ir.model.access and ir.rule with one model, ir.access: security/ir.access.csv rows grant (with a group) or restrict (without a group) CRUD operations, optionally limited by a domain.',
        body: [
            'CSV: security/ir.access.csv with header id,name,model_id,group_id/id,operation,domain. model_id is the technical model name (e.g. crm.lead), group_id/id the group XML id, operation a subset of "crud" in that letter order (crud, cru, r, ru, ...), domain an optional domain string.',
            'Semantics (base/models/ir_access.py): a row with a group is a permission; permissions of the user\'s groups are OR-ed. A row without a group is a restriction for everyone; restrictions are AND-ed. Domains are evaluated with user, time, company_ids and company_id.',
            'Example from core crm: "crm_rule_personal_lead,Personal Leads,crm.lead,sales_team.group_sale_salesman,cru,[\'|\',(\'user_id\',\'=\',user.id),(\'user_id\',\'=\',False)]" and the multi-company restriction "crm_lead_company_rule,...,crm.lead,,crud,[(\'company_id\', \'in\', company_ids + [False])]".',
            'API: records.check_access(operation), has_access(operation), _filtered_access(operation). check_access_rights() and check_access_rule() no longer exist in 20.0.',
            'There is no ir.model.access or ir.rule model in 20.0; do not copy 19-style ACL CSVs or ir.rule XML. Test with non-admin users (with_user); the superuser bypasses access checks.',
        ].join('\n'),
        sources: [src('base/models/ir_access.py (20.0)', 'https://raw.githubusercontent.com/odoo/odoo/20.0/odoo/addons/base/models/ir_access.py', '20.0'), src('crm/security/ir.access.csv (20.0)', 'https://raw.githubusercontent.com/odoo/odoo/20.0/addons/crm/security/ir.access.csv', '20.0')],
    },
    {
        id: 'odoo-security-migration-20', title: 'Migrating access rules from 19 to 20 (ir.access)', tags: ['security', 'migration', 'ir-access'], appliesTo: { odooMajors: [20] },
        summary: 'Porting a module to 20.0 means converting ir.model.access.csv rows and ir.rule records into security/ir.access.csv rows and replacing removed check_access_rights/check_access_rule calls.',
        body: [
            '1. Each 19 ir.model.access row (model, group, perm_read/write/create/unlink) becomes an ir.access permission row: model_id = technical model name, group_id/id = same group, operation = the letters of the granted permissions in "crud" order (perm_create->c, perm_read->r, perm_write->u, perm_unlink->d), no domain.',
            '2. A 19 group record rule becomes a permission row with that group, its operations and its domain. Note the semantic difference: a 20 permission with a domain grants only those records, so check whether the 19 module combined an unrestricted access right with a restricting group rule and reproduce the intended effective access.',
            '3. A 19 global record rule (no group) becomes a restriction row without group_id (restrictions are AND-ed for everyone).',
            '4. Replace security/ir.model.access.csv with security/ir.access.csv in the manifest data list; remove ir.rule XML records.',
            '5. Replace check_access_rights()/check_access_rule() with check_access()/has_access(), and _filter_access_rules() with _filtered_access().',
            '6. Run the upgrade_code dry run and the module tests with non-admin users. Whether upgrade_code rewrites ACL files for a given module is not guaranteed; review the result against the 20.0 source.',
        ].join('\n'),
        sources: [src('base/models/ir_access.py (20.0)', 'https://raw.githubusercontent.com/odoo/odoo/20.0/odoo/addons/base/models/ir_access.py', '20.0'), src('crm/security/ir.access.csv (20.0)', 'https://raw.githubusercontent.com/odoo/odoo/20.0/addons/crm/security/ir.access.csv', '20.0'), src('crm/security/ir.model.access.csv (19.0)', 'https://github.com/odoo/odoo/blob/19.0/addons/crm/security/ir.model.access.csv', '19.0')],
    },
    {
        id: 'odoo-views', title: 'Views and XML inheritance', tags: ['views', 'xml', 'xpath'], appliesTo: { odooMajors: [19, 20] },
        summary: 'Views are ir.ui.view records; inherited views modify a parent with xpath/position. Modern versions use <list> for list views and plain Python-expression attributes such as invisible="state == \'done\'".',
        body: [
            '- Define views as records of ir.ui.view in XML data files listed in the manifest.',
            '- Extend with inherit_id and <xpath expr="..." position="after|before|inside|replace|attributes">; prefer precise anchors (field names) over positional paths.',
            '- List views use the <list> element (the older <tree> name is from versions before 18).',
            '- Conditional visibility/readonly/required are expressed directly as attributes with Python-like expressions; the attrs/states attributes of versions before 17 are not used anymore.',
            '- Keep XML ids stable: renaming an id creates a new record and leaves the old one behind on update.',
            'Validate XML well-formedness and reference ids before running the server; the inspection tool lists data files that are referenced but missing.',
        ].join('\n'),
        sources: [...bothOdoo('developer/reference/user_interface/view_architectures.html', 'View architectures'), ...bothOdoo('developer/reference/backend/data.html', 'Data files')],
    },
    {
        id: 'odoo-frontend', title: 'Web client: Owl components, registries, assets', tags: ['owl', 'javascript', 'assets'], appliesTo: { odooMajors: [19, 20] },
        summary: 'The web client is built from Owl components registered in registries and using services; files reach the browser only through asset bundles declared in the manifest.',
        body: [
            '- Components are Owl classes with a static template; register them in the relevant registry category (fields, views, actions, systray, ...).',
            '- Use services (useService) for RPC, notifications, actions and ORM calls instead of ad-hoc globals.',
            '- Declare JS/SCSS/XML templates in the manifest assets key under the correct bundle (for example web.assets_backend). Files that are not in a bundle are never loaded.',
            '- Patch existing components with the patch utility rather than copying them.',
            'Read the frontend reference of the configured major; the component and registry APIs evolve between majors.',
        ].join('\n'),
        sources: bothOdoo('developer/reference/frontend/owl_components.html', 'Owl components'),
    },
    {
        id: 'odoo-testing', title: 'Testing: Python tests, tags, tours and HOOT', tags: ['testing', 'hoot', 'tours'], appliesTo: { odooMajors: [19, 20] },
        summary: 'Python tests live in tests/ and are selected with --test-tags; HttpCase covers tours. JavaScript unit tests use HOOT at /web/tests. Select modules explicitly; 20 changed default tagging behaviour.',
        body: [
            '- Python tests: modules under <module>/tests imported by tests/__init__.py; base classes TransactionCase (rolled back per test) and HttpCase (browser/tour tests, needs a headless browser).',
            '- Tagging: @tagged(...) with at_install/post_install; run selected tests with --test-tags, for example /my_module or /my_module:TestClass.test_method, together with -i or -u and --stop-after-init.',
            '- The 20.0 documentation describes changed default tagging behaviour compared with 19. Always select the module explicitly with --test-tags instead of relying on defaults.',
            '- Frontend unit tests use HOOT; the runner page is /web/tests. Do not write new QUnit-only workflows.',
            '- Run tests against a disposable hapi_test_* database. A run that never reached the test phase (import error, missing dependency) is a failure, not a pass.',
        ].join('\n'),
        sources: [...bothOdoo('developer/reference/backend/testing.html', 'Testing Odoo'), odooDoc(20, 'developer/reference/frontend/unit_testing/hoot.html', 'HOOT')],
    },
    {
        id: 'odoo-external-api', title: 'External API: JSON-2 and the XML/JSON-RPC timeline', tags: ['api', 'json-2', 'rpc'], appliesTo: { odooMajors: [19, 20] },
        summary: 'Odoo 19 introduced the JSON-2 API (/json/2/<model>/<method>, bearer API keys, normal access rights). XML-RPC and JSON-RPC are deprecated with removal scheduled for Odoo 22, not 20.',
        body: [
            '- JSON-2: POST /json/2/<model>/<method> with an API key as bearer token; calls run with the permissions of the key owner.',
            '- XML-RPC (/xmlrpc/2/...) and JSON-RPC (/jsonrpc) are deprecated. Current documentation schedules their removal for Odoo 22 (fall 2028). Material claiming removal in 20 is outdated.',
            '- This is the business application API of an Odoo database. It is not an Odoo.sh hosting/control-plane API; Odoo.sh builds, backups and branches are managed in the Odoo.sh UI.',
            '- Store API keys only as project secrets/Vault resources, never in the repository, knowledge or prompts.',
        ].join('\n'),
        sources: bothOdoo('developer/reference/external_api.html', 'External API'),
    },
    {
        id: 'odoo-upgrades', title: 'Module upgrades and migration scripts', tags: ['upgrade', 'migration'], appliesTo: { odooMajors: [19, 20] },
        summary: 'Updating a module (-u) reloads its data; a version bump runs migrations/<version>/pre-, post- and end- scripts. odoo-bin upgrade_code offers best-effort source rewrites; start with --dry-run.',
        body: [
            '- Install (-i) and update (-u) differ: update reloads data files and runs migration scripts for the new version only.',
            '- Migration scripts: migrations/<module version>/pre-*.py, post-*.py, end-*.py with a migrate(cr, version) function. They run once when the installed version is lower than the manifest version.',
            '- upgrade_util helpers from Odoo support common data migrations; see the upgrade utils reference.',
            '- odoo-bin upgrade_code applies source-code upgrade scripts between versions (--from/--to) and supports --dry-run. Its scripts are best effort and do not prove correctness; review every proposed change and run tests afterwards.',
            '- Never run a migration against production data from a HAPI session. Use a disposable copy.',
        ].join('\n'),
        sources: [...bothOdoo('developer/reference/upgrades/upgrade_utils.html', 'Upgrade utils'), odooDoc(20, 'developer/reference/cli.html', 'Command-line interface (upgrade_code)')],
    },
    {
        id: 'odoo-sh-branches', title: 'Odoo.sh branches and stages', tags: ['odoo-sh', 'deployment', 'branches'], appliesTo: { odooMajors: [19, 20] },
        summary: 'Odoo.sh branches are development, staging or production. A push builds the branch; production pushes update the live database, staging uses neutralised production copies, development builds start from fresh databases.',
        body: [
            '- Development branches: each push creates a new build with a fresh database (demo/test data) and runs tests. Builds are temporary.',
            '- Staging branches: builds use a neutralised copy of the production database (outgoing mail, crons and similar are disabled).',
            '- Production branch: a push updates the production build and database.',
            'Consequence for HAPI: git push to an Odoo.sh-linked repository can be a deployment. HAPI settings keep the local development branch separate from the declared staging and production branches. Never push to a staging or production branch unless a human explicitly asked for that exact stage.',
            '- HAPI stores staging and production separately (branch, build ID, build host, optional Vault references). Use exactly the stage the human named; a missing stage is undeclared, never assume production or the default branch.',
            'Odoo.sh has no documented public control-plane API. Creating builds, rebuilding, promoting, backups and restores are browser actions in Odoo.sh.',
        ].join('\n'),
        sources: [odooDoc(19, 'administration/odoo_sh/getting_started/branches.html', 'Odoo.sh branches'), src('Odoo.sh branches (documentation source, 19.0)', 'https://github.com/odoo/documentation/blob/19.0/content/administration/odoo_sh/getting_started/branches.rst', '19.0')],
    },
    {
        id: 'odoo-sh-connection', title: 'Odoo.sh: GitHub status, SSH and online editor', tags: ['odoo-sh', 'ssh', 'github-status'], appliesTo: { odooMajors: [19, 20] },
        summary: 'Odoo.sh can post commit statuses to GitHub (setting with a statuses token). SSH is per build (build ID as user, exact build host). The online editor edits a build container; changes are lost unless committed.',
        body: [
            '- GitHub commit status: Odoo.sh settings can send build results as GitHub commit statuses. Only then can HAPI read them through the project GitHub grant (fixed read of the combined status). No status means unknown, not success.',
            '- SSH: connect as <build id>@<build host> exactly as shown in Odoo.sh. The public key is registered in the user\'s Odoo.sh profile and access follows the project role. Development builds are temporary, so the host changes with new builds.',
            '- HAPI never generates or copies SSH keys; an operator may configure an existing Vault SSH resource per stage (staging and production are separate references).',
            '- The build ID is the numeric identifier Odoo.sh shows for a build (the SSH user); it is not a GitHub URL or commit. The build host is the exact domain of that build.',
            '- Online editor: <build URL>/odoo-sh/editor. Edits there live in the build container and disappear unless committed and pushed.',
        ].join('\n'),
        sources: [src('Odoo.sh settings (documentation source, 19.0)', 'https://github.com/odoo/documentation/blob/19.0/content/administration/odoo_sh/getting_started/settings.rst', '19.0'), odooDoc(19, 'administration/odoo_sh/getting_started/branches.html', 'Odoo.sh branches'), odooDoc(19, 'administration/odoo_sh/getting_started/online_editor.html', 'Odoo.sh online editor'), src('GitHub REST: commit statuses', 'https://docs.github.com/en/rest/commits/statuses')],
    },
    {
        id: 'odoo-quality-tooling', title: 'Lint and pre-commit for Odoo modules', tags: ['lint', 'pre-commit', 'oca'], appliesTo: { odooMajors: [19, 20] },
        summary: 'OCA pylint-odoo and odoo-pre-commit-hooks check manifests, XML and CSV with version-aware rules. Use the project\'s own configuration and pinned versions; never replace them silently.',
        body: [
            '- pylint-odoo provides Odoo-specific pylint checks; configure the valid Odoo version for the target major.',
            '- odoo-pre-commit-hooks adds manifest, XML and CSV checks.',
            '- If the repository already has .pre-commit-config.yaml or pylint configuration, run that configuration unchanged. Propose changes separately.',
            '- Linters complement tests; a clean lint run says nothing about runtime behaviour.',
        ].join('\n'),
        sources: [src('OCA pylint-odoo', 'https://github.com/OCA/pylint-odoo'), src('OCA odoo-pre-commit-hooks', 'https://github.com/OCA/odoo-pre-commit-hooks')],
    },
]

const odooPack: DevelopmentPackInput = {
    id: 'odoo', version: '2026.10.18-1', title: 'Odoo 19 / 20', verifiedAt: VERIFIED,
    summary: 'Odoo module development for 19.0 or 20.0 with a version-specific handbook, local source runtime recipes, static module inspection and optional Odoo.sh build status from GitHub.',
    brief: [
        'The configured Odoo major is the target. Prefer the checked-out 19.0/20.0 source (release.py, code) over general memory.',
        'Never import or execute __manifest__.py to read it; use the inspection tool or a literal parser.',
        'Tests run against disposable hapi_test_* databases on a project-local PostgreSQL cluster; never against shared or production data.',
        'For Odoo.sh repositories, a push can deploy. Staging and production are configured separately; act only on the stage a human named explicitly.',
        'The local development branch is not an Odoo.sh stage. Never infer production or a default branch when a stage is not declared.',
        'Odoo.sh has no public control-plane API; build actions are browser actions.',
    ],
    constraints: [
        'Odoo 19: Python >= 3.10, PostgreSQL >= 13. Odoo 20: Python >= 3.12, PostgreSQL >= 16.',
        'XML-RPC and JSON-RPC removal is scheduled for Odoo 22, not 20.',
        'Enterprise source is never cloned automatically.',
        'The Enterprise repository setting is a reference only: doctor, inspection and the test helper use the bound checkout and Community source; a separate Enterprise checkout is not added to the addons path automatically.',
        'Odoo.sh build status comes only from GitHub commit statuses, when Odoo.sh is set to send them.',
        'SSH to Odoo.sh builds needs a key registered in your Odoo.sh profile; HAPI does not create keys.',
        'Activation installs nothing and starts no build; setup tasks state their effects first.',
    ],
    topics: odooTopics,
    doctorChecks: [
        { id: 'image.marker', label: 'Development runner image', category: 'image', required: false, appliesTo: {} },
        { id: 'git', label: 'Git', category: 'toolchain', required: true, appliesTo: {} },
        { id: 'python', label: 'Python interpreter (version vs. Odoo minimum)', category: 'runtime', required: true, appliesTo: {} },
        { id: 'python.venv', label: 'Python venv module', category: 'runtime', required: true, appliesTo: {} },
        { id: 'postgresql.server', label: 'PostgreSQL server binaries (initdb, pg_ctl)', category: 'database', required: true, appliesTo: {} },
        { id: 'postgresql.client', label: 'PostgreSQL client (psql)', category: 'database', required: false, appliesTo: {} },
        { id: 'odoo.source', label: 'Odoo source checkout in project toolchain', category: 'toolchain', required: true, appliesTo: {} },
        { id: 'odoo.venv', label: 'Odoo virtual environment', category: 'toolchain', required: true, appliesTo: {} },
        { id: 'postgresql.cluster', label: 'Project PostgreSQL cluster', category: 'database', required: true, appliesTo: {} },
        { id: 'node', label: 'Node.js (assets, lint)', category: 'toolchain', required: false, appliesTo: {} },
        { id: 'browser', label: 'Headless Chromium (HttpCase, tours, HOOT)', category: 'runtime', required: false, appliesTo: {} },
        { id: 'wkhtmltopdf', label: 'wkhtmltopdf (PDF reports)', category: 'runtime', required: false, appliesTo: {} },
        { id: 'ssh', label: 'SSH client (Odoo.sh builds)', category: 'integration', required: false, appliesTo: {} },
        { id: 'repository.checkout', label: 'Bound repository checkout', category: 'project', required: true, appliesTo: {} },
    ],
    recipes: [
        {
            id: 'odoo-source', title: 'Check out Odoo source', kind: 'setup', effects: ['network_download', 'installs_in_project'], prerequisites: ['git'], appliesTo: {},
            summary: 'Shallow clone of the public odoo/odoo branch matching the configured major into the project toolchain directory; the helper records the source revision in source.json.',
            steps: [
                { title: 'Clone or reuse', detail: 'The helper clones only the public Community branch {major}.0. An existing {toolchainDir}/odoo/{major}/src is never deleted, reset or replaced; it is reused and its revision reported.', argv: [HELPER, 'odoo', 'source', '--major', '{major}'] },
                { title: 'Report revision', detail: 'Report the commit recorded in {toolchainDir}/odoo/{major}/source.json. If a human explicitly asks to update an existing checkout, fetch and check out the branch without discarding local changes.' },
            ],
            outputs: ['.hapi/.cache/toolchain/odoo/{major}/src', '.hapi/.cache/toolchain/odoo/{major}/source.json'],
            guardrails: ['Never clone Enterprise unless an authorised granted repository is configured and a human asked for it.', 'Never delete or reset an existing toolchain directory.'],
            sources: [src('odoo/odoo on GitHub', 'https://github.com/odoo/odoo')],
        },
        {
            id: 'odoo-venv', title: 'Create Odoo virtual environment', kind: 'setup', effects: ['network_download', 'installs_in_project'], prerequisites: ['python', 'python.venv', 'odoo.source'], appliesTo: {},
            summary: 'Project-local venv with the pinned requirements of the checked-out source. The doctor must show an interpreter within the configured major\'s supported range first.',
            steps: [
                { title: 'Create or extend venv', detail: 'Creates {toolchainDir}/odoo/{major}/venv once and installs the source requirements.txt into it. Missing system headers produce build errors; report them instead of installing system packages.', argv: [HELPER, 'odoo', 'venv', '--major', '{major}'] },
                { title: 'Repository requirements', detail: 'If the repository has its own requirements.txt, install it into the same venv only after reviewing it: {toolchainDir}/odoo/{major}/venv/bin/python -m pip install -r <file>.' },
            ],
            outputs: ['.hapi/.cache/toolchain/odoo/{major}/venv'],
            guardrails: ['Never use sudo or install global packages.', 'Report the interpreter and pip versions used.'],
            sources: [odooDoc(19, 'administration/on_premise/source.html', 'Source install'), odooDoc(20, 'administration/on_premise/source.html', 'Source install')],
        },
        {
            id: 'odoo-postgres-cluster', title: 'Start project PostgreSQL cluster', kind: 'setup', effects: ['installs_in_project', 'creates_local_database'], prerequisites: ['postgresql.server'], appliesTo: {},
            summary: 'Private PostgreSQL 17 cluster in the project toolchain directory, Unix socket only (no TCP), for disposable hapi_test_* databases.',
            steps: [
                { title: 'Initialise once', detail: 'Creates {toolchainDir}/postgresql/17/data only if it does not exist.', argv: [HELPER, 'postgres', 'init'] },
                { title: 'Start', detail: 'Starts the cluster with TCP disabled. The socket lives in {toolchainDir}/postgresql/run, or in a private /tmp/hapi-pg-<hash> directory when that path is too long for a Unix socket; the helper and doctor resolve it the same way. The server log is {toolchainDir}/postgresql/17/server.log.', argv: [HELPER, 'postgres', 'start'] },
                { title: 'Status', detail: 'Read-only status check.', argv: [HELPER, 'postgres', 'status'] },
            ],
            outputs: ['.hapi/.cache/toolchain/postgresql/17/data', '.hapi/.cache/toolchain/postgresql/run'],
            guardrails: ['Never drop databases that do not start with hapi_test_.', 'Never delete an existing data directory.', 'The server must not listen on TCP.'],
            sources: [src('PostgreSQL: initdb', 'https://www.postgresql.org/docs/current/app-initdb.html'), src('PostgreSQL: pg_ctl', 'https://www.postgresql.org/docs/current/app-pg-ctl.html')],
        },
        {
            id: 'odoo-test-module', title: 'Run module tests on a disposable database', kind: 'test', effects: ['runs_project_code', 'creates_local_database', 'reads_repository'], prerequisites: ['odoo.source', 'odoo.venv', 'postgresql.cluster', 'repository.checkout'], appliesTo: {},
            summary: 'Install every selected module into hapi_test_<slug> and run their tests; the helper passes one --test-tags selector per module (/a,/b).',
            steps: [
                { title: 'Choose modules', detail: '{modules} is the comma-separated list of ALL configured modules. If none are configured, run the development inspection first and use the discovered installable module names explicitly; never run with an empty or guessed selector.' },
                { title: 'Run', detail: '{checkout} is the effective repository checkout of this session; {addonsPaths} are the configured repository-relative addons directories.', argv: [HELPER, 'odoo', 'test', '--major', '{major}', '--repository', '{checkout}', '--modules', '{modules}', '--addons', '{addonsPaths}', '--db-slug', '{testDatabaseSlug}'] },
                { title: 'Report', detail: 'Summarise passed/failed tests per module from the log and summary.json, the Odoo source revision and the repository HEAD. An import or install error is a failure.' },
            ],
            outputs: ['.hapi/.cache/artifacts/odoo/{timestamp}/test.log', '.hapi/.cache/artifacts/odoo/{timestamp}/summary.json'],
            guardrails: ['Only hapi_test_* databases.', 'Do not mark tests skipped or delete tests to get a green run.'],
            sources: [odooDoc(19, 'developer/reference/backend/testing.html', 'Testing Odoo'), odooDoc(20, 'developer/reference/backend/testing.html', 'Testing Odoo'), odooDoc(20, 'developer/reference/cli.html', 'Command-line interface')],
        },
        {
            id: 'odoo-upgrade-dry-run', title: 'Upgrade code dry run (to 20.0)', kind: 'upgrade', effects: ['reads_repository', 'runs_project_code'], prerequisites: ['odoo.source', 'odoo.venv', 'repository.checkout'], appliesTo: { odooMajors: [20] },
            summary: 'Run the 20.0 upgrade_code scripts in --dry-run mode over the repository modules, then review proposed changes before editing.',
            steps: [
                { title: 'Dry run', detail: 'Uses the 20.0 source and venv; no file is changed.', argv: [HELPER, 'odoo', 'upgrade-dry-run', '--repository', '{checkout}', '--addons', '{addonsPaths}', '--from', '19.0', '--to', '20.0'] },
                { title: 'Plan', detail: 'List proposed changes per module, manifest version bumps (20.0.x.y.z), the conversion of ir.model.access.csv/ir.rule to security/ir.access.csv (topic odoo-security-migration-20) and needed migrations/ scripts. Apply changes only after review, then run module tests.' },
            ],
            outputs: ['.hapi/.cache/artifacts/odoo/{timestamp}/upgrade-dry-run.log'],
            guardrails: ['Never run against production data.', 'upgrade_code is best effort; tests decide.'],
            sources: [odooDoc(20, 'developer/reference/cli.html', 'Command-line interface (upgrade_code)'), odooDoc(20, 'developer/reference/upgrades/upgrade_utils.html', 'Upgrade utils')],
        },
        {
            id: 'odoo-lint', title: 'Run project lint and pre-commit', kind: 'test', effects: ['reads_repository', 'runs_project_code', 'network_download', 'writes_repository'], prerequisites: ['odoo.venv', 'repository.checkout'], appliesTo: {},
            summary: 'Run the repository\'s own pre-commit/pylint configuration if present. Hooks execute project-defined tools and may reformat files.',
            steps: [
                { title: 'Detect', detail: 'Look for .pre-commit-config.yaml, .pylintrc or setup.cfg in {checkout}. Without a configuration, propose pylint-odoo / odoo-pre-commit-hooks for the target major instead of running anything.' },
                { title: 'Install pre-commit', detail: 'Into the Odoo venv only.', argv: ['{toolchainDir}/odoo/{major}/venv/bin/python', '-m', 'pip', 'install', 'pre-commit'] },
                { title: 'Run existing configuration', detail: 'Run in {checkout}; report changed files instead of committing them.', argv: ['{toolchainDir}/odoo/{major}/venv/bin/pre-commit', 'run', '--all-files'] },
            ],
            outputs: [], guardrails: ['Do not rewrite lint configuration without a request.', 'Never commit hook changes without reviewing them.'],
            sources: [src('OCA pylint-odoo', 'https://github.com/OCA/pylint-odoo'), src('OCA odoo-pre-commit-hooks', 'https://github.com/OCA/odoo-pre-commit-hooks')],
        },
        {
            id: 'odoo-sh-diagnose', title: 'Diagnose an Odoo.sh build', kind: 'diagnose', effects: ['reads_repository', 'manual_handoff'], prerequisites: ['repository.checkout'], appliesTo: {},
            summary: 'Correlate the GitHub commit status of one explicitly chosen Odoo.sh stage (or ref) with local history; SSH or browser access to the build stays a human/operator step.',
            steps: [
                { title: 'Choose the target', detail: 'Use exactly the target the human named: a configured Odoo.sh stage (staging or production) or a Git ref (branch or full SHA). A stage is available only with Odoo.sh hosting and a declared branch for that stage; otherwise say it is unavailable and use only an explicit ref the human gives. If no target was named, ask before reading any status; never assume staging, production or the default branch.' },
                { title: 'Read status', detail: 'Use evolved_development_build_status with environment=<stage> (or ref=<branch|sha>): check that the response names the same environment, ref and configuration revision; then state, resolved SHA and observation time. no_status/unknown is not success.' },
                { title: 'Correlate', detail: 'Compare the reported SHA with local git log; summarise changes since the last successful status.' },
                { title: 'Handoff', detail: 'If logs are needed, give the human the Odoo.sh project link and the copyable SSH command of that same stage from the development context (integrations odoo-sh-staging / odoo-sh-production). Do not open SSH unless an operator-configured Vault resource of that stage is explicitly granted.' },
            ],
            outputs: [], guardrails: ['Never push to trigger a rebuild without explicit request; pushes can deploy.'],
            sources: [src('GitHub REST: commit statuses', 'https://docs.github.com/en/rest/commits/statuses'), odooDoc(19, 'administration/odoo_sh/getting_started/branches.html', 'Odoo.sh branches')],
        },
    ],
    tasks: [
        { id: 'odoo-setup-runtime', title: 'Set up local Odoo runtime', kind: 'setup', specialist: 'builtin:implementation', recipeIds: ['odoo-source', 'odoo-venv', 'odoo-postgres-cluster'], topicIds: ['odoo-versions', 'odoo-runtime-19', 'odoo-runtime-20'], requiresRepository: false, appliesTo: {},
            description: 'Check out the matching Odoo source, create the venv and start a private PostgreSQL cluster in the project toolchain directory.',
            defaultTask: 'Set up the local Odoo runtime for this project following the setup recipes. Run the development doctor first, keep existing toolchain directories, and report versions and the source revision.',
            effects: [], notes: ['Needs Python and PostgreSQL server binaries on the runner (development runner image).', 'Downloads the public Odoo source (several hundred MB).'] },
        { id: 'odoo-develop-module', title: 'Develop a module change', kind: 'develop', specialist: 'builtin:implementation', recipeIds: ['odoo-test-module'], topicIds: ['odoo-module-manifest-19', 'odoo-module-manifest-20', 'odoo-orm', 'odoo-security-19', 'odoo-security-20', 'odoo-views', 'odoo-frontend'], requiresRepository: true, appliesTo: {},
            description: 'Implement a feature or fix in the repository using conventions of the configured Odoo major, with tests.',
            defaultTask: 'Describe the module change here. Follow the conventions of the configured Odoo major, add or update tests, and run the module tests on a disposable database.',
            effects: ['writes_repository'], notes: [] },
        { id: 'odoo-add-tests', title: 'Add access and behaviour tests', kind: 'test', specialist: 'builtin:tests', recipeIds: ['odoo-test-module'], topicIds: ['odoo-testing', 'odoo-security-19', 'odoo-security-20'], requiresRepository: true, appliesTo: {},
            description: 'Add Python tests that exercise access control (ir.model.access/ir.rule in 19, ir.access in 20) and key behaviour with non-admin users.',
            defaultTask: 'Add tests for the configured modules covering the access control of the configured Odoo major and the main business flows, then run them on a disposable database.',
            effects: ['writes_repository'], notes: [] },
        { id: 'odoo-run-tests', title: 'Run module tests', kind: 'test', specialist: 'builtin:tests', recipeIds: ['odoo-test-module'], topicIds: ['odoo-testing'], requiresRepository: true, appliesTo: {},
            description: 'Install all configured modules into hapi_test_<slug>, run their tests and report results with source and repository revisions.',
            defaultTask: 'Run the tests of all configured modules on a disposable database and report the results per module, the Odoo source revision and the repository HEAD.',
            effects: [], notes: ['Requires the local runtime (setup task).'] },
        { id: 'odoo-lint', title: 'Run lint and pre-commit', kind: 'test', specialist: 'builtin:tests', recipeIds: ['odoo-lint'], topicIds: ['odoo-quality-tooling'], requiresRepository: true, appliesTo: {},
            description: 'Run the repository\'s existing pre-commit/pylint configuration and report findings and reformatted files.',
            defaultTask: 'Run the repository\'s existing lint and pre-commit configuration and summarise findings. Report files changed by hooks; do not commit them.',
            effects: [], notes: ['Hooks run project-defined tools and may reformat files.'] },
        { id: 'odoo-upgrade-20', title: 'Prepare 19 -> 20 migration', kind: 'upgrade', specialist: 'builtin:architecture', recipeIds: ['odoo-upgrade-dry-run'], topicIds: ['odoo-upgrades', 'odoo-security-migration-20', 'odoo-versions', 'odoo-runtime-20'], requiresRepository: true, appliesTo: { odooMajors: [20] },
            description: 'Dry-run the 20.0 upgrade_code scripts and plan manifest bumps, migration scripts and test changes.',
            defaultTask: 'Prepare the migration of the repository modules from 19.0 to 20.0: run the upgrade_code dry run, list proposed changes per module and propose a reviewed plan. Do not apply changes yet.',
            effects: [], notes: ['Uses the 20.0 source checkout.'] },
        { id: 'odoo-review', title: 'Review module changes', kind: 'review', specialist: 'builtin:review', recipeIds: [], topicIds: ['odoo-security-19', 'odoo-security-20', 'odoo-module-manifest-19', 'odoo-module-manifest-20', 'odoo-quality-tooling'], requiresRepository: true, appliesTo: {},
            description: 'Read-only adversarial review of current changes: security rules, manifest/data order, version conventions. Runs no hooks or tools.',
            defaultTask: 'Review the current changes in the repository for Odoo-specific correctness: access control for the configured major (19: ir.model.access/ir.rule, 20: ir.access), manifest data order, version numbers and test coverage. Read existing lint configuration and results; do not run tools.',
            effects: ['reads_repository'], notes: ['Starts in read-only/plan mode.', 'Use "Run lint and pre-commit" to execute hooks.'] },
        { id: 'odoo-sh-build', title: 'Check Odoo.sh build', kind: 'diagnose', specialist: 'builtin:review', recipeIds: ['odoo-sh-diagnose'], topicIds: ['odoo-sh-branches', 'odoo-sh-connection'], requiresRepository: true, appliesTo: {},
            description: 'Read the GitHub commit status of one explicitly named Odoo.sh stage and correlate it with recent commits.',
            defaultTask: 'Check the build status of one explicitly named target through the GitHub commit status. Target (name exactly one; leave both empty to be asked): Odoo.sh stage = <staging or production, as configured for this project>, or Git ref = <branch or full commit SHA>. If no target is named here, first ask the human which configured stage or ref to check; never choose a stage or default branch yourself. A stage without Odoo.sh hosting or without a declared branch is unavailable: say so and ask for a ref. Then correlate the result with recent commits and summarise what a human should check.',
            effects: [], notes: ['Status exists only if Odoo.sh is configured to send GitHub commit statuses.', 'Logs and shells on builds are human/operator steps.'] },
    ],
    integrations: [
        { id: 'github-status', title: 'GitHub commit status', kind: 'live_read', description: 'Fixed read of the combined commit status of the bound repository for a branch or SHA, through the project GitHub grant.', limits: ['Requires the token permission "Commit statuses: read".', 'Shows only what Odoo.sh or CI posts; missing status is unknown.'], sources: [src('GitHub REST: commit statuses', 'https://docs.github.com/en/rest/commits/statuses')] },
        { id: 'odoo-sh-project', title: 'Odoo.sh project', kind: 'manual', description: 'Validated link to the shared Odoo.sh project dashboard. Browser actions stay in Odoo.sh.', limits: ['No public Odoo.sh control-plane API.'], sources: [odooDoc(19, 'administration/odoo_sh/getting_started/branches.html', 'Odoo.sh branches')] },
        { id: 'odoo-sh-staging', title: 'Odoo.sh staging', kind: 'reference', description: 'Declared staging branch, build and online-editor links and copyable SSH command of the staging build; optional Vault references of this stage.', limits: ['HAPI never generates or copies SSH keys and opens no connection.', 'Staging builds use a neutralised copy of production; the host changes with new builds.'], sources: [odooDoc(19, 'administration/odoo_sh/getting_started/branches.html', 'Odoo.sh branches')] },
        { id: 'odoo-sh-production', title: 'Odoo.sh production', kind: 'reference', description: 'Declared production branch, build and online-editor links and copyable SSH command of the production build; optional Vault references of this stage.', limits: ['A push to the production branch deploys to the live database.', 'HAPI never generates or copies SSH keys and opens no connection.'], sources: [odooDoc(19, 'administration/odoo_sh/getting_started/branches.html', 'Odoo.sh branches')] },
        { id: 'odoo-sh-unassigned', title: 'Odoo.sh: unassigned earlier details', kind: 'manual', description: 'Odoo.sh details saved before staging and production were separate, without a staging/production stage. Shown for manual assignment only.', limits: ['Never used as staging or production.'], sources: [] },
        { id: 'odoo-application-api', title: 'Odoo application API (JSON-2)', kind: 'reference', description: 'Reference to an existing Vault resource for an Odoo database API. Business API, not hosting control.', limits: ['Only actions configured by the operator in Vault.'], sources: [odooDoc(19, 'developer/reference/external_api.html', 'External API')] },
    ],
}

// ------------------------------------------------------------------ iOS

const appleSystem = src('Xcode system requirements', 'https://developer.apple.com/xcode/system-requirements')
const iosTopics: DevelopmentTopic[] = [
    {
        id: 'ios-linux-boundaries', title: 'What a Linux runner can and cannot do for iOS', tags: ['linux', 'xcode', 'limits'], appliesTo: {},
        summary: 'Xcode, iOS simulators, UI tests, signing and app builds require macOS. A Linux runner can edit code, run portable Swift packages and prepare CI/release work.',
        body: [
            '- Not possible on Linux: xcodebuild, iOS SDK compilation, simulators, UI tests, code signing, device installs, App Store uploads.',
            '- Possible on Linux: editing Swift/Objective-C/project files, building and testing platform-independent Swift packages with a Linux Swift toolchain, static review, CI workflow changes, release notes and checklists.',
            '- Native verification happens on a Mac, in Xcode Cloud or on macOS CI runners. Report clearly which checks ran where; never present a Linux run as an iOS build result.',
            '- Supported Xcode/macOS combinations change; check the system requirements page instead of assuming the latest version.',
        ].join('\n'),
        sources: [appleSystem],
    },
    {
        id: 'ios-swiftpm-linux', title: 'Portable Swift packages on Linux', tags: ['swift', 'swiftpm', 'linux'], appliesTo: {},
        summary: 'Logic without Apple UI frameworks can live in Swift packages that build and test on Linux with swift build / swift test. Guard Apple-only code with canImport.',
        body: [
            '- Install a Linux Swift toolchain from swift.org (verify the signature); it is not part of the default runner.',
            '- swift build and swift test --package-path <dir> work for packages whose targets do not import UIKit, SwiftUI or other Apple-only frameworks.',
            '- Guard platform-specific code with #if canImport(UIKit) / #if os(iOS); keep domain logic, parsing and networking models in portable targets.',
            '- Foundation on Linux (swift-corelibs / swift-foundation) differs in places from Apple platforms; test the code paths that matter on both when possible.',
            '- A target that imports UIKit/SwiftUI is "not Linux-testable"; list it as such instead of reporting a failure.',
        ].join('\n'),
        sources: [src('Swift: install on Linux', 'https://www.swift.org/install/linux/'), src('Swift Package Manager', 'https://www.swift.org/documentation/package-manager/')],
    },
    {
        id: 'ios-testing', title: 'XCTest and Swift Testing', tags: ['testing', 'xctest', 'swift-testing'], appliesTo: {},
        summary: 'Swift Testing (@Test, #expect) and XCTest coexist. Unit tests of portable packages can run on Linux; app and UI tests need Xcode on macOS.',
        body: [
            '- Swift Testing uses @Test functions, #expect/#require and suites; XCTest uses XCTestCase subclasses. Both can be in the same package.',
            '- UI tests (XCUITest) and app-hosted tests need a simulator or device and therefore macOS.',
            '- Prefer fast unit tests for logic in packages; keep UI tests focused on critical flows.',
            '- When adding tests, follow the framework the project already uses.',
        ].join('\n'),
        sources: [src('Swift Testing', 'https://developer.apple.com/documentation/testing'), src('XCTest', 'https://developer.apple.com/documentation/xctest')],
    },
    {
        id: 'ios-xcode-cloud', title: 'Xcode Cloud: setup boundary and cost', tags: ['xcode-cloud', 'ci', 'cost'], appliesTo: {},
        summary: 'The first Xcode Cloud workflow and the app-repository connection are created in Xcode on a Mac. Afterwards App Store Connect APIs can read products, workflows and builds. Builds consume compute quota.',
        body: [
            '- Initial setup: in Xcode, create the first workflow and connect the source repository. The App Store Connect API documents reading and deleting products, not creating them.',
            '- After setup, workflows, build runs and artifacts are available through App Store Connect APIs with appropriate credentials.',
            '- Every build run consumes Xcode Cloud compute hours. Workflows with distribution actions upload to TestFlight.',
            '- In HAPI, Xcode Cloud is a manual handoff or an explicitly granted existing resource/MCP server. Activation, doctor and status views never start builds.',
        ].join('\n'),
        sources: [src('Configuring your first Xcode Cloud workflow', 'https://developer.apple.com/documentation/xcode/configuring-your-first-xcode-cloud-workflow'), src('App Store Connect API: Products', 'https://developer.apple.com/documentation/appstoreconnectapi/products')],
    },
    {
        id: 'ios-signing-distribution', title: 'Signing and distribution', tags: ['signing', 'testflight', 'release'], appliesTo: {},
        summary: 'Certificates, provisioning profiles and App Store Connect keys stay outside the repository. Distribution to TestFlight/App Store happens from Xcode, Xcode Cloud or CI with protected credentials.',
        body: [
            '- Never commit certificates, private keys, .p8 API keys or provisioning profiles. Reference them as CI/Vault secrets.',
            '- Automatic signing in Xcode manages profiles for development; release signing usually runs in Xcode Cloud or CI.',
            '- Release preparation that a Linux session can do: version/build number bump, changelog, privacy manifest review, checking that no secrets or debug flags ship.',
            '- Uploading a build is a distribution effect and needs explicit human intent.',
        ].join('\n'),
        sources: [src('Distributing your app for beta testing and releases', 'https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases')],
    },
    {
        id: 'ios-privacy-manifest', title: 'Privacy manifests', tags: ['privacy', 'app-store'], appliesTo: {},
        summary: 'Apps and SDKs declare collected data and required-reason API use in PrivacyInfo.xcprivacy. Missing declarations can block App Store submission.',
        body: [
            '- PrivacyInfo.xcprivacy is a property list in the app or SDK bundle describing tracking, collected data types and reasons for using certain APIs.',
            '- Third-party SDKs ship their own manifests; the app\'s manifest covers the app\'s own code.',
            '- Review the manifest whenever adding analytics, file timestamp, user defaults, disk space or similar APIs listed by Apple.',
            'The inspection tool lists privacy manifests found in the repository.',
        ].join('\n'),
        sources: [src('Privacy manifest files', 'https://developer.apple.com/documentation/bundleresources/privacy-manifest-files')],
    },
    {
        id: 'ios-concurrency', title: 'Swift concurrency and the main actor', tags: ['swift', 'concurrency'], appliesTo: {},
        summary: 'async/await, actors and Sendable checking prevent data races; UI state belongs on the main actor. Swift 6 language mode turns data-race diagnostics into errors.',
        body: [
            '- Mark UI-facing types and view models @MainActor; do UI updates only there.',
            '- Use actors for shared mutable state; values crossing concurrency domains must be Sendable.',
            '- Prefer structured concurrency (async let, task groups) over detached tasks; handle cancellation.',
            '- Migrating to Swift 6 language mode can surface many diagnostics; migrate module by module.',
        ].join('\n'),
        sources: [src('The Swift Programming Language: Concurrency', 'https://docs.swift.org/swift-book/documentation/the-swift-programming-language/concurrency/')],
    },
    {
        id: 'ios-accessibility', title: 'Accessibility', tags: ['accessibility', 'ui'], appliesTo: {},
        summary: 'Support VoiceOver labels, Dynamic Type and sufficient contrast; SwiftUI and UIKit expose accessibility modifiers and properties.',
        body: [
            '- Give interactive elements meaningful labels and hints; hide decorative images from assistive technologies.',
            '- Respect Dynamic Type; avoid fixed font sizes and clipped layouts.',
            '- Check contrast and do not encode meaning only in colour.',
            '- Accessibility verification needs a simulator/device (Accessibility Inspector, VoiceOver), i.e. macOS.',
        ].join('\n'),
        sources: [src('Apple Accessibility documentation', 'https://developer.apple.com/documentation/accessibility')],
    },
    {
        id: 'ios-github-actions', title: 'Native iOS CI on GitHub Actions', tags: ['ci', 'github-actions'], appliesTo: {},
        summary: 'GitHub-hosted macOS runners can build and test with xcodebuild; they cost more than Linux minutes. Linux jobs can run portable package tests first.',
        body: [
            '- Typical job: macOS runner, select Xcode, xcodebuild -scheme <scheme> -destination "platform=iOS Simulator,name=..." test.',
            '- Run cheap Linux checks (portable Swift package tests, lint) before macOS jobs.',
            '- Signing secrets belong in encrypted repository/environment secrets; never echo them in logs.',
            '- HAPI does not trigger workflows; it can prepare workflow changes in the repository for review.',
        ].join('\n'),
        sources: [src('GitHub-hosted runners', 'https://docs.github.com/en/actions/reference/runners/github-hosted-runners')],
    },
]

const iosPack: DevelopmentPackInput = {
    id: 'ios', version: '2026.10.17-1', title: 'iOS', verifiedAt: VERIFIED,
    summary: 'iOS app work from a Linux runner: project configuration, honest native capability checks, portable Swift package tests, CI/Xcode Cloud handoffs and release preparation.',
    brief: [
        'This runner is Linux: no Xcode, simulator, signing or iOS build. Say which checks ran where.',
        'Portable Swift packages can be built and tested on Linux if a Swift toolchain is installed.',
        'Xcode Cloud setup starts in Xcode on a Mac; builds cost quota and are never started automatically.',
        'Signing material and App Store Connect keys never belong in the repository.',
    ],
    constraints: [
        'Linux runners cannot build, sign or run iOS apps, simulators or UI tests.',
        'Xcode Cloud: the first workflow is created in Xcode on a Mac. Every build consumes quota.',
        'HAPI shows Xcode Cloud as manual setup unless an existing granted resource is configured; it never starts builds.',
        'A Swift toolchain for Linux is optional and installed only by an explicit setup task.',
    ],
    topics: iosTopics,
    doctorChecks: [
        { id: 'image.marker', label: 'Development runner image', category: 'image', required: false, appliesTo: {} },
        { id: 'git', label: 'Git', category: 'toolchain', required: true, appliesTo: {} },
        { id: 'host.macos', label: 'macOS host (Xcode builds)', category: 'runtime', required: false, appliesTo: {} },
        { id: 'xcodebuild', label: 'xcodebuild', category: 'toolchain', required: false, appliesTo: {} },
        { id: 'simulator', label: 'iOS simulator (simctl)', category: 'device', required: false, appliesTo: {} },
        { id: 'swift', label: 'Swift toolchain (portable packages)', category: 'toolchain', required: false, appliesTo: {} },
        { id: 'repository.checkout', label: 'Bound repository checkout', category: 'project', required: true, appliesTo: {} },
    ],
    recipes: [
        {
            id: 'ios-swift-toolchain', title: 'Install Linux Swift toolchain', kind: 'setup', effects: ['network_download', 'installs_in_project'], prerequisites: [], appliesTo: {},
            summary: 'Download an official swift.org Linux toolchain for the runner distribution into the project toolchain directory and verify its PGP signature.',
            steps: [
                { title: 'Choose version', detail: 'Match the Swift version the project targets (Package.swift tools version) as {swiftVersion}; omit --version to use the helper default.' },
                { title: 'Install and verify', detail: 'Installs into {toolchainDir}/swift/<version> and records the active version in {toolchainDir}/swift/current.json; aborts when the signature cannot be verified. Existing installations are reused.', argv: [HELPER, 'swift', 'install', '--version', '{swiftVersion}'] },
            ],
            outputs: ['.hapi/.cache/toolchain/swift/{swiftVersion}', '.hapi/.cache/toolchain/swift/current.json'], guardrails: ['No sudo or global installs.', 'Abort if the signature cannot be verified.'],
            sources: [src('Swift: install on Linux', 'https://www.swift.org/install/linux/')],
        },
        {
            id: 'ios-swiftpm-test', title: 'Test portable Swift packages', kind: 'test', effects: ['runs_project_code', 'reads_repository'], prerequisites: ['swift', 'repository.checkout'], appliesTo: {},
            summary: 'Run swift test with the installed project toolchain for packages whose targets are Linux-portable; list non-portable targets explicitly.',
            steps: [
                { title: 'Find packages', detail: 'Use the inspection result (Package.swift files) inside {checkout}; {packageDirectory} is the repository-relative directory of one package.' },
                { title: 'Run', detail: 'The helper uses the Swift binary recorded in {toolchainDir}/swift/current.json (or a system Swift), never an arbitrary PATH entry.', argv: [HELPER, 'swift', 'test', '--package', '{checkout}/{packageDirectory}'] },
                { title: 'Report', detail: 'Separate passed, failed and "not Linux-testable" (UIKit/SwiftUI imports) targets.' },
            ],
            outputs: ['.hapi/.cache/artifacts/ios/{timestamp}/swift-test.log'], guardrails: ['Never claim an iOS build or UI test from a Linux run.'],
            sources: [src('Swift Package Manager', 'https://www.swift.org/documentation/package-manager/')],
        },
        {
            id: 'ios-native-ci', title: 'Prepare native CI change', kind: 'develop', effects: ['writes_repository'], prerequisites: ['repository.checkout'], appliesTo: {},
            summary: 'Prepare or fix a GitHub Actions / Xcode Cloud configuration in the repository; native runs happen on macOS after human review and push.',
            steps: [
                { title: 'Inspect', detail: 'Read existing workflows (.github/workflows, ci_scripts) and the configured scheme.' },
                { title: 'Change', detail: 'Write CI steps that call xcodebuild on macOS with the configured scheme as a single argument (xcodebuild -scheme <scheme> -destination ... test). Do not run xcodebuild on this Linux runner.' },
                { title: 'Handoff', detail: 'State that the change was not executed on macOS and what a human must run or review.' },
            ],
            outputs: [], guardrails: ['Do not start Xcode Cloud builds or workflows.', 'No signing secrets in workflow files.'],
            sources: [src('GitHub-hosted runners', 'https://docs.github.com/en/actions/reference/runners/github-hosted-runners'), src('Configuring your first Xcode Cloud workflow', 'https://developer.apple.com/documentation/xcode/configuring-your-first-xcode-cloud-workflow')],
        },
        {
            id: 'ios-release-prep', title: 'Release preparation checklist', kind: 'release', effects: ['writes_repository', 'manual_handoff'], prerequisites: ['repository.checkout'], appliesTo: {},
            summary: 'Version/build bump, changelog, privacy manifest and secret review in the repository; upload remains a human/CI step.',
            steps: [
                { title: 'Versions', detail: 'Update MARKETING_VERSION / CURRENT_PROJECT_VERSION (or the project\'s mechanism) consistently.' },
                { title: 'Privacy and secrets', detail: 'Review PrivacyInfo.xcprivacy files and ensure no keys, certificates or debug endpoints are committed.' },
                { title: 'Handoff', detail: 'List what needs a Mac/Xcode Cloud run before TestFlight.' },
            ],
            outputs: [], guardrails: ['Never upload builds.'],
            sources: [src('Privacy manifest files', 'https://developer.apple.com/documentation/bundleresources/privacy-manifest-files'), src('Distributing your app for beta testing and releases', 'https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases')],
        },
    ],
    tasks: [
        { id: 'ios-setup-linux', title: 'Set up Linux Swift tooling', kind: 'setup', specialist: 'builtin:implementation', recipeIds: ['ios-swift-toolchain'], topicIds: ['ios-linux-boundaries', 'ios-swiftpm-linux'], requiresRepository: false, appliesTo: {},
            description: 'Install a verified swift.org toolchain into the project toolchain directory for portable package tests.',
            defaultTask: 'Install a verified Linux Swift toolchain into the project toolchain directory for the Swift version this project uses, then report the installed version.',
            effects: [], notes: ['Optional: only needed for portable Swift package tests.', 'Does not enable iOS builds on Linux.'] },
        { id: 'ios-develop-feature', title: 'Develop a feature', kind: 'develop', specialist: 'builtin:implementation', recipeIds: ['ios-swiftpm-test'], topicIds: ['ios-concurrency', 'ios-accessibility', 'ios-testing', 'ios-linux-boundaries'], requiresRepository: true, appliesTo: {},
            description: 'Implement a change in the repository; test portable parts on Linux and hand off native verification.',
            defaultTask: 'Describe the feature here. Implement it, test portable Swift packages where possible, and list the native checks a Mac or CI must still run.',
            effects: ['writes_repository'], notes: ['Native build and UI tests are not available on Linux.'] },
        { id: 'ios-portable-tests', title: 'Run portable tests', kind: 'test', specialist: 'builtin:tests', recipeIds: ['ios-swiftpm-test'], topicIds: ['ios-swiftpm-linux', 'ios-testing'], requiresRepository: true, appliesTo: {},
            description: 'Run swift test for Linux-portable packages and report non-portable targets separately.',
            defaultTask: 'Run the tests of all Linux-portable Swift packages in the repository and report passed, failed and not-Linux-testable targets.',
            effects: [], notes: ['Requires a Swift toolchain (setup task).'] },
        { id: 'ios-fix-ci', title: 'Fix native CI configuration', kind: 'diagnose', specialist: 'builtin:implementation', recipeIds: ['ios-native-ci'], topicIds: ['ios-github-actions', 'ios-xcode-cloud'], requiresRepository: true, appliesTo: {},
            description: 'Diagnose a failing native CI configuration from logs you provide and prepare a reviewed change.',
            defaultTask: 'Paste the failing CI log here. Diagnose the cause and prepare a fix in the repository. Do not start Xcode Cloud or CI runs.',
            effects: [], notes: ['HAPI cannot read Xcode Cloud logs itself unless a granted resource exists.'] },
        { id: 'ios-release-prep', title: 'Prepare a release', kind: 'release', specialist: 'builtin:implementation', recipeIds: ['ios-release-prep'], topicIds: ['ios-signing-distribution', 'ios-privacy-manifest'], requiresRepository: true, appliesTo: {},
            description: 'Prepare version bump, changelog and privacy review; upload stays a human or CI step.',
            defaultTask: 'Prepare the next release in the repository: version and build numbers, changelog, privacy manifest and secret review. Do not upload builds.',
            effects: [], notes: ['TestFlight uploads use paid/quota resources and need a human.'] },
        { id: 'ios-review', title: 'Review iOS changes', kind: 'review', specialist: 'builtin:review', recipeIds: [], topicIds: ['ios-concurrency', 'ios-accessibility', 'ios-privacy-manifest'], requiresRepository: true, appliesTo: {},
            description: 'Read-only review for concurrency, accessibility, privacy and platform-boundary mistakes.',
            defaultTask: 'Review the current changes for main-actor/concurrency issues, accessibility, privacy manifest impact and code that cannot be verified on Linux.',
            effects: ['reads_repository'], notes: ['Starts in read-only/plan mode.'] },
    ],
    integrations: [
        { id: 'xcode-cloud', title: 'Xcode Cloud', kind: 'manual', description: 'Manual setup in Xcode on a Mac; optionally reference an existing granted Vault resource or project MCP server.', limits: ['No live connection claimed.', 'Builds consume quota and are never started by HAPI.'], sources: [src('Configuring your first Xcode Cloud workflow', 'https://developer.apple.com/documentation/xcode/configuring-your-first-xcode-cloud-workflow')] },
        { id: 'github-status', title: 'GitHub commit status', kind: 'live_read', description: 'Fixed read of the combined commit status (e.g. from GitHub Actions statuses) of the bound repository.', limits: ['Check runs are not included; only commit statuses.'], sources: [src('GitHub REST: commit statuses', 'https://docs.github.com/en/rest/commits/statuses')] },
    ],
}

// ------------------------------------------------------------------ Android

const androidTopics: DevelopmentTopic[] = [
    {
        id: 'android-jdk-agp', title: 'JDK, Gradle and AGP compatibility', tags: ['jdk', 'gradle', 'agp'], appliesTo: {},
        summary: 'The JDK that runs Gradle must match the Android Gradle Plugin and Gradle versions of the project. AGP 9.0 requires at least JDK 17; do not force one JDK for every project.',
        body: [
            '- Gradle runs on a JDK (JAVA_HOME or org.gradle.java.home); toolchains can compile with another JDK.',
            '- Determine the required JDK from the project\'s AGP and Gradle wrapper versions (gradle/wrapper/gradle-wrapper.properties, version catalog/build files). AGP 9.0 names JDK 17 as minimum; newer JDKs such as 21 are commonly used.',
            '- The Gradle wrapper and build scripts are project code. Reading their files is safe; running ./gradlew executes the project and may download dependencies.',
        ].join('\n'),
        sources: [src('Java versions in Android builds', 'https://developer.android.com/build/jdks'), src('AGP 9.0.0 release notes', 'https://developer.android.com/build/releases/agp-9-0-0-release-notes', 'AGP 9.0')],
    },
    {
        id: 'android-cmdline-builds', title: 'Command-line builds, APK and AAB', tags: ['gradle', 'build', 'apk'], appliesTo: {},
        summary: 'Build with the project\'s Gradle wrapper (assemble<Variant>, bundle<Variant>). An APK installs directly on a device; an AAB is for Play distribution and is not directly installable.',
        body: [
            '- ./gradlew :<module>:assemble<Variant> produces APKs under <module>/build/outputs/apk/.',
            '- ./gradlew :<module>:bundle<Variant> produces an AAB for Play; it cannot be installed with adb install.',
            '- Debug builds are signed with the debug key and suitable for device testing; release builds need a release signing configuration.',
            '- HAPI recipes copy produced APKs to .hapi/.cache/artifacts/android/<timestamp>/ with a SHA-256 checksum.',
        ].join('\n'),
        sources: [src('Build your app from the command line', 'https://developer.android.com/build/building-cmdline')],
    },
    {
        id: 'android-sdk-licenses', title: 'SDK installation and licences', tags: ['sdk', 'sdkmanager', 'licenses'], appliesTo: {},
        summary: 'sdkmanager installs SDK packages (platforms, build-tools, platform-tools). Packages require accepted licences; acceptance is a human decision and never implicit.',
        body: [
            '- Install the command-line tools, then use sdkmanager --sdk_root=<dir> to install platform-tools, platforms;android-<compileSdk> and build-tools.',
            '- Licences must be accepted before packages install. In HAPI a project admin first acknowledges licence review in project settings; the setup session then shows the licences to the human.',
            '- Keep the SDK in the project toolchain directory (ANDROID_HOME pointing there); do not modify system directories.',
        ].join('\n'),
        sources: [src('sdkmanager', 'https://developer.android.com/tools/sdkmanager')],
    },
    {
        id: 'android-testing', title: 'Local and instrumented tests', tags: ['testing', 'junit', 'instrumentation'], appliesTo: {},
        summary: 'Local unit tests (src/test) run on the JVM with ./gradlew test<Variant>UnitTest; instrumented tests (src/androidTest) need a device or emulator.',
        body: [
            '- Local tests run on the build machine JVM and are fast; use them for logic.',
            '- Instrumented tests run on a device/emulator (connected<Variant>AndroidTest); they need adb and a running device.',
            '- Test reports land under <module>/build/reports/tests and build/test-results (JUnit XML).',
            '- A missing emulator does not block code work or local unit tests.',
        ].join('\n'),
        sources: [src('Fundamentals of testing Android apps', 'https://developer.android.com/training/testing/fundamentals')],
    },
    {
        id: 'android-emulator', title: 'Emulator acceleration and devices', tags: ['emulator', 'kvm', 'device'], appliesTo: {},
        summary: 'The emulator needs a system image and hardware acceleration (KVM on Linux). Check with emulator -accel-check; nested virtualisation may not work. Build capability does not imply emulator capability.',
        body: [
            '- Linux acceleration uses KVM; the runner user needs read/write access to /dev/kvm.',
            '- emulator -accel-check reports whether acceleration is usable.',
            '- Containers and nested virtual machines often lack usable KVM; report this as unsupported rather than trying software emulation for tests.',
            '- HAPI never starts emulators automatically.',
        ].join('\n'),
        sources: [src('Configure hardware acceleration for the Android Emulator', 'https://developer.android.com/studio/run/emulator-acceleration'), src('GitHub-hosted runners', 'https://docs.github.com/en/actions/reference/runners/github-hosted-runners')],
    },
    {
        id: 'android-lint-r8', title: 'Lint and R8 shrinking', tags: ['lint', 'r8', 'release'], appliesTo: {},
        summary: 'Android Lint finds correctness, security and performance issues (./gradlew lint<Variant>). Release builds commonly enable R8; keep rules must protect reflection-based code.',
        body: [
            '- Lint reports land in <module>/build/reports/lint-results-*.html/xml; a lint baseline may hide existing issues.',
            '- R8 shrinks, optimises and obfuscates release builds; missing keep rules show up as runtime crashes (ClassNotFound, missing serializers).',
            '- Test release-like builds before shipping when shrinking is enabled.',
        ].join('\n'),
        sources: [src('Improve your code with lint checks', 'https://developer.android.com/studio/write/lint'), src('Shrink, obfuscate, and optimize your app', 'https://developer.android.com/build/shrink-code')],
    },
    {
        id: 'android-signing', title: 'App signing', tags: ['signing', 'release', 'security'], appliesTo: {},
        summary: 'Release keystores and passwords never belong in the repository. Play App Signing separates the upload key from the app signing key.',
        body: [
            '- Keep keystores and passwords in CI/Vault secrets; reference them from Gradle via environment variables or local properties ignored by Git.',
            '- With Play App Signing, Google holds the app signing key and you sign uploads with an upload key.',
            '- Debug builds use an auto-generated debug keystore and are fine for local device testing.',
        ].join('\n'),
        sources: [src('Sign your app', 'https://developer.android.com/studio/publish/app-signing')],
    },
    {
        id: 'android-compose-state', title: 'Compose state and lifecycle', tags: ['compose', 'state', 'lifecycle'], appliesTo: {},
        summary: 'Compose UI is a function of state: hoist state, keep business state in ViewModels and collect flows lifecycle-aware.',
        body: [
            '- remember/rememberSaveable hold UI element state; hoist state to callers to keep composables reusable and testable.',
            '- Keep screen state in a ViewModel and expose it as StateFlow; collect with collectAsStateWithLifecycle.',
            '- Side effects belong in effect handlers (LaunchedEffect, DisposableEffect), not directly in composition.',
        ].join('\n'),
        sources: [src('State and Jetpack Compose', 'https://developer.android.com/develop/ui/compose/state')],
    },
    {
        id: 'android-permissions', title: 'Runtime permissions', tags: ['permissions', 'privacy'], appliesTo: {},
        summary: 'Dangerous permissions are requested at runtime in context; declare only what the app needs and handle denial gracefully.',
        body: [
            '- Declare permissions in the manifest; request dangerous ones at runtime when the feature is used.',
            '- Handle denial and "don\'t ask again" without blocking unrelated features.',
            '- Review new permissions in pull requests; they affect store listing and user trust.',
        ].join('\n'),
        sources: [src('Permissions on Android', 'https://developer.android.com/guide/topics/permissions/overview')],
    },
    {
        id: 'android-cli-agents', title: 'Official Android CLI for agents', tags: ['android-cli', 'agents', 'tools'], appliesTo: {},
        summary: 'Google documents an agent-oriented Android CLI with SDK/emulator management, device/UI tools and a knowledge base (android docs search/fetch). It is optional; Gradle and adb remain the fallback.',
        body: [
            '- android docs search "<query>" and android docs fetch kb://... read the official knowledge base.',
            '- android info reports environment information.',
            '- Use --no-metrics to disable usage metrics.',
            '- Installing official agent skills must not silently overwrite existing global skills.',
        ].join('\n'),
        sources: [src('Android CLI overview', 'https://developer.android.com/tools/agents/android-cli'), src('Android CLI: docs', 'https://developer.android.com/tools/agents/android-cli/commands/docs'), src('Android CLI: info', 'https://developer.android.com/tools/agents/android-cli/commands/info'), src('Android skills', 'https://developer.android.com/tools/agents/android-skills')],
    },
]

const androidPack: DevelopmentPackInput = {
    id: 'android', version: '2026.10.17-1', title: 'Android', verifiedAt: VERIFIED,
    summary: 'Android app work on a Linux runner: Gradle/JDK/SDK checks without running project code, explicit SDK setup after licence acknowledgement, unit tests, lint and debug APK artifacts with checksums.',
    brief: [
        'Running ./gradlew executes project code; reading build files does not.',
        'SDK packages install only after a project admin acknowledged licence review and a human started setup.',
        'Emulator capability (KVM) is separate from build capability; emulators are never started automatically.',
        'Artifacts go to .hapi/.cache/artifacts/android/<timestamp>/ with SHA-256 checksums.',
    ],
    constraints: [
        'Android SDK packages install only after licence acknowledgement by a project admin and an explicit setup task.',
        'Doctor never runs the Gradle wrapper or project build scripts.',
        'Emulators need usable KVM; HAPI never starts them automatically.',
        'Artifacts stay in the project directory; there is no download service.',
    ],
    topics: androidTopics,
    doctorChecks: [
        { id: 'image.marker', label: 'Development runner image', category: 'image', required: false, appliesTo: {} },
        { id: 'git', label: 'Git', category: 'toolchain', required: true, appliesTo: {} },
        { id: 'java', label: 'JDK', category: 'runtime', required: true, appliesTo: {} },
        { id: 'android.sdk', label: 'Android SDK directory', category: 'sdk', required: true, appliesTo: {} },
        { id: 'android.sdkmanager', label: 'sdkmanager (command-line tools)', category: 'sdk', required: false, appliesTo: {} },
        { id: 'android.licenses', label: 'Accepted SDK licences (files present)', category: 'sdk', required: true, appliesTo: {} },
        { id: 'android.platform-tools', label: 'adb (platform-tools)', category: 'device', required: false, appliesTo: {} },
        { id: 'android.emulator', label: 'Emulator binary', category: 'device', required: false, appliesTo: {} },
        { id: 'kvm', label: 'KVM access (/dev/kvm)', category: 'device', required: false, appliesTo: {} },
        { id: 'android.cli', label: 'Android CLI (optional)', category: 'toolchain', required: false, appliesTo: {} },
        { id: 'gradle.wrapper', label: 'Gradle wrapper in project (not executed)', category: 'project', required: true, appliesTo: {} },
        { id: 'repository.checkout', label: 'Bound repository checkout', category: 'project', required: true, appliesTo: {} },
    ],
    recipes: [
        {
            id: 'android-sdk-setup', title: 'Install Android SDK packages', kind: 'setup', effects: ['network_download', 'installs_in_project', 'requires_license_acknowledgement'], prerequisites: ['java'], appliesTo: {},
            summary: 'Install the official command-line tools and the SDK packages the project needs into the project toolchain directory, after a project admin acknowledged licence review.',
            steps: [
                { title: 'Acknowledgement', detail: 'HAPI starts this task only after a project admin acknowledged SDK licence review in project settings; the helper re-checks the project setting itself.' },
                { title: 'Command-line tools', detail: 'Downloads the pinned, checksum-verified command-line tools into {toolchainDir}/android/sdk.', argv: [HELPER, 'android', 'sdk', 'bootstrap'] },
                { title: 'Show licences', detail: 'Interactive: the human reads and accepts the licences in the session terminal. Never pipe "yes" or accept on their behalf.', argv: [HELPER, 'android', 'sdk', 'licenses'] },
                { title: 'Determine versions', detail: 'Use settings.android.compileSdk; if it is null, read compileSdk and the build-tools version from the project build files ({checkout}/{projectDirectory}) without running Gradle. Stop and ask when they cannot be determined; never install a guessed platform. Omit --build-tools when no version is known.' },
                { title: 'Packages', detail: 'Installs the compile SDK platform, optional build-tools and platform-tools. New, unaccepted licences abort instead of being accepted.', argv: [HELPER, 'android', 'sdk', 'install', '--compile-sdk', '{compileSdk}', '--build-tools', '{buildTools}', '--platform-tools'] },
            ],
            outputs: ['.hapi/.cache/toolchain/android/sdk'], guardrails: ['Never accept licences automatically.', 'No system-wide installation.'],
            sources: [src('sdkmanager', 'https://developer.android.com/tools/sdkmanager')],
        },
        {
            id: 'android-unit-test', title: 'Run unit tests', kind: 'test', effects: ['runs_project_code', 'network_download'], prerequisites: ['java', 'android.sdk', 'gradle.wrapper', 'repository.checkout'], appliesTo: {},
            summary: 'Run local JVM unit tests of the configured module and variant via the project Gradle wrapper in {checkout}/{projectDirectory}.',
            steps: [
                { title: 'Run', detail: 'The helper sets ANDROID_HOME and a project Gradle home for this process only and runs gradlew in {checkout}/{projectDirectory} (projectDirectory \'.\' = the checkout itself).', argv: [HELPER, 'android', 'gradle', 'unit-test', '--project', '{checkout}/{projectDirectory}', '--module', '{module}', '--variant', '{variant}'] },
                { title: 'Report', detail: 'Summarise the JUnit XML copied to .hapi/.cache/artifacts/android/{timestamp}/.' },
            ],
            outputs: ['.hapi/.cache/artifacts/android/{timestamp}/'], guardrails: ['Runs project build scripts; only in the session checkout.'],
            sources: [src('Fundamentals of testing Android apps', 'https://developer.android.com/training/testing/fundamentals')],
        },
        {
            id: 'android-lint', title: 'Run Android Lint', kind: 'test', effects: ['runs_project_code', 'network_download'], prerequisites: ['java', 'android.sdk', 'gradle.wrapper', 'repository.checkout'], appliesTo: {},
            summary: 'Run lint for the configured module and variant and summarise new findings.',
            steps: [{ title: 'Run', detail: 'Respect an existing lint baseline.', argv: [HELPER, 'android', 'gradle', 'lint', '--project', '{checkout}/{projectDirectory}', '--module', '{module}', '--variant', '{variant}'] }],
            outputs: ['.hapi/.cache/artifacts/android/{timestamp}/'], guardrails: ['Do not regenerate the lint baseline without a request.'],
            sources: [src('Improve your code with lint checks', 'https://developer.android.com/studio/write/lint')],
        },
        {
            id: 'android-assemble-debug', title: 'Build debug APK artifact', kind: 'test', effects: ['runs_project_code', 'network_download'], prerequisites: ['java', 'android.sdk', 'gradle.wrapper', 'repository.checkout'], appliesTo: {},
            summary: 'Assemble the configured debug variant (debug or <flavor>Debug) and store the APK with SHA256SUMS under .hapi/.cache/artifacts/android/<timestamp>/.',
            steps: [
                { title: 'Build', detail: 'HAPI starts this task only when the configured variant is a debug variant; release variants are refused before the session starts.', argv: [HELPER, 'android', 'gradle', 'assemble', '--project', '{checkout}/{projectDirectory}', '--module', '{module}', '--variant', '{variant}'] },
                { title: 'Report', detail: 'Report APK path, SHA-256 from SHA256SUMS, commit and variant. An AAB is not directly installable.' },
            ],
            outputs: ['.hapi/.cache/artifacts/android/{timestamp}/'], guardrails: ['Never build release variants or use release signing secrets in this recipe.'],
            sources: [src('Build your app from the command line', 'https://developer.android.com/build/building-cmdline')],
        },
        {
            id: 'android-emulator-check', title: 'Check emulator acceleration', kind: 'diagnose', effects: [], prerequisites: ['android.emulator'], appliesTo: {},
            summary: 'Run the documented acceleration check; never start an emulator.',
            steps: [{ title: 'Check', detail: 'Read-only check of KVM usability.', argv: ['{toolchainDir}/android/sdk/emulator/emulator', '-accel-check'] }],
            outputs: [], guardrails: ['Do not start emulators or install system images without a request.'],
            sources: [src('Configure hardware acceleration for the Android Emulator', 'https://developer.android.com/studio/run/emulator-acceleration')],
        },
    ],
    tasks: [
        { id: 'android-setup-sdk', title: 'Set up Android SDK', kind: 'setup', specialist: 'builtin:implementation', recipeIds: ['android-sdk-setup'], topicIds: ['android-sdk-licenses', 'android-jdk-agp'], requiresRepository: false, appliesTo: {},
            preconditions: ['android_sdk_license_acknowledged'],
            description: 'Install command-line tools and required SDK packages into the project toolchain directory; licences are shown to you in the session.',
            defaultTask: 'Set up the Android SDK for this project in the project toolchain directory following the setup recipe. Show me the SDK licences instead of accepting them automatically.',
            effects: [], notes: ['Starts only after a project admin acknowledged SDK licence review in project settings.', 'Requires a JDK on the runner (development runner image).'] },
        { id: 'android-develop-feature', title: 'Develop a feature', kind: 'develop', specialist: 'builtin:implementation', recipeIds: ['android-unit-test'], topicIds: ['android-compose-state', 'android-permissions', 'android-testing'], requiresRepository: true, appliesTo: {},
            description: 'Implement a change in the repository and verify it with unit tests.',
            defaultTask: 'Describe the feature here. Implement it in the configured module, add unit tests and run them.',
            effects: ['writes_repository'], notes: [] },
        { id: 'android-test-lint', title: 'Unit tests and lint', kind: 'test', specialist: 'builtin:tests', recipeIds: ['android-unit-test', 'android-lint'], topicIds: ['android-testing', 'android-lint-r8'], requiresRepository: true, appliesTo: {},
            description: 'Run unit tests and lint of the configured module/variant and summarise findings.',
            defaultTask: 'Run the unit tests and lint for the configured module and variant and summarise failures and new lint findings.',
            effects: [], notes: ['Requires JDK and SDK (setup task).'] },
        { id: 'android-debug-apk', title: 'Build debug APK', kind: 'test', specialist: 'builtin:tests', recipeIds: ['android-assemble-debug'], topicIds: ['android-cmdline-builds'], requiresRepository: true, appliesTo: {},
            preconditions: ['android_debug_variant'],
            description: 'Build a debug APK of the configured debug variant for device testing and store it with a checksum in the project directory.',
            defaultTask: 'Build a debug APK of the configured module and store it with its SHA-256 checksum under .hapi/.cache/artifacts/android/.',
            effects: [], notes: ['Only debug variants (debug, <flavor>Debug); release variants are refused.', 'The APK stays in the project directory; there is no download link.'] },
        { id: 'android-release-prep', title: 'Prepare a release', kind: 'release', specialist: 'builtin:implementation', recipeIds: [], topicIds: ['android-signing', 'android-lint-r8'], requiresRepository: true, appliesTo: {},
            description: 'Version bump, changelog, R8/keep-rule and signing-configuration review without using release secrets.',
            defaultTask: 'Prepare the next release: versionCode/versionName, changelog, shrinking/keep-rule review and a check that no signing secrets are committed. Do not build or upload a signed release.',
            effects: ['writes_repository'], notes: ['Signed release builds and Play uploads need a human/CI with secrets.'] },
        { id: 'android-review', title: 'Review Android changes', kind: 'review', specialist: 'builtin:review', recipeIds: [], topicIds: ['android-permissions', 'android-compose-state', 'android-signing'], requiresRepository: true, appliesTo: {},
            description: 'Read-only review for lifecycle/state, permission and signing mistakes.',
            defaultTask: 'Review the current changes for Compose state and lifecycle issues, new permissions, signing configuration and missing tests.',
            effects: ['reads_repository'], notes: ['Starts in read-only/plan mode.'] },
    ],
    integrations: [
        { id: 'github-status', title: 'GitHub commit status', kind: 'live_read', description: 'Fixed read of the combined commit status of the bound repository.', limits: ['Check runs are not included; only commit statuses.'], sources: [src('GitHub REST: commit statuses', 'https://docs.github.com/en/rest/commits/statuses')] },
        { id: 'android-device', title: 'Device / emulator', kind: 'manual', description: 'Physical devices and emulators are prepared by a human; doctor reports KVM and adb availability.', limits: ['Emulators are never started automatically.'], sources: [src('Configure hardware acceleration for the Android Emulator', 'https://developer.android.com/studio/run/emulator-acceleration')] },
    ],
}

// ------------------------------------------------------------------ registry

/** A task shows every effect of the recipes it hands to the agent, plus its own (e.g. editing code). */
function finalize(pack: DevelopmentPackInput): DevelopmentPack {
    const parsed = DevelopmentPackSchema.parse(pack)
    return { ...parsed, tasks: parsed.tasks.map(task => {
        const recipes = parsed.recipes.filter(recipe => task.recipeIds.includes(recipe.id))
        return { ...task, effects: DEVELOPMENT_EFFECTS.filter(effect => task.effects.includes(effect) || recipes.some(recipe => recipe.effects.includes(effect))) }
    }) }
}
export const DEVELOPMENT_PACKS: Readonly<Record<SpecializedDevelopmentMode, DevelopmentPack>> = Object.freeze({
    odoo: finalize(odooPack),
    ios: finalize(iosPack),
    android: finalize(androidPack),
})
const revisions = new Map<SpecializedDevelopmentMode, string>()
export function developmentPack(mode: SpecializedDevelopmentMode): DevelopmentPack { return DEVELOPMENT_PACKS[mode] }
export function developmentPackRevision(mode: SpecializedDevelopmentMode): string {
    let value = revisions.get(mode)
    if (!value) { value = developmentContentHash(DEVELOPMENT_PACKS[mode]); revisions.set(mode, value) }
    return value
}
const summary = ({ body: _body, ...topic }: DevelopmentTopic) => topic
export function developmentCatalogEntry(mode: SpecializedDevelopmentMode): DevelopmentModeCatalogEntry {
    const pack = DEVELOPMENT_PACKS[mode]
    return { mode, title: pack.title, summary: pack.summary, packVersion: pack.version, packRevision: developmentPackRevision(mode), verifiedAt: pack.verifiedAt,
        constraints: pack.constraints, topics: pack.topics.map(summary), recipes: pack.recipes, tasks: pack.tasks, doctorChecks: pack.doctorChecks, integrations: pack.integrations,
        ...(mode === 'odoo' ? { odooMajors: [19, 20] as Array<19 | 20> } : {}) }
}
export function developmentCatalog(): DevelopmentModeCatalog {
    return { contractVersion: DEVELOPMENT_CONTRACT_VERSION, modes: (['odoo', 'ios', 'android'] as const).map(developmentCatalogEntry) }
}
/** Pack items filtered for the configured version (e.g. Odoo 19 never sees 20-only topics). */
export function applicablePack(settings: DevelopmentSettings) {
    if (settings.mode === 'none') return null
    const pack = DEVELOPMENT_PACKS[settings.mode], fits = (item: { appliesTo: DevelopmentTopic['appliesTo'] }) => developmentApplies(item.appliesTo, settings)
    const topics = pack.topics.filter(fits), topicIds = new Set(topics.map(topic => topic.id))
    // Task topic references are filtered too, so a 19 project never sees 20-only topic ids (and vice versa).
    const tasks = pack.tasks.filter(fits).map(task => ({ ...task, topicIds: task.topicIds.filter(id => topicIds.has(id)) }))
    return { pack, revision: developmentPackRevision(settings.mode), topics, recipes: pack.recipes.filter(fits), tasks, doctorChecks: pack.doctorChecks.filter(fits) }
}

/**
 * Bounded local search over the applicable topics: case-insensitive token
 * match weighted by title, tags, summary and body. No network, no index.
 */
export function searchDevelopmentTopics(topics: readonly DevelopmentTopic[], query: string, limit = 8): Array<{ topic: DevelopmentTopic; score: number; excerpt: string }> {
    const tokens = [...new Set(query.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}_.-]+/u).filter(token => token.length >= 2))].slice(0, 12)
    if (!tokens.length) return []
    const hits: Array<{ topic: DevelopmentTopic; score: number; excerpt: string }> = []
    for (const topic of topics) {
        const title = topic.title.toLowerCase(), summaryText = topic.summary.toLowerCase(), body = topic.body.toLowerCase(), tags = topic.tags.join(' ')
        let score = 0, first = -1
        for (const token of tokens) {
            const inBody = body.indexOf(token)
            const value = (title.includes(token) ? 5 : 0) + (tags.includes(token) || topic.id.includes(token) ? 4 : 0) + (summaryText.includes(token) ? 3 : 0) + (inBody >= 0 ? 1 : 0)
            score += value
            if (inBody >= 0 && (first < 0 || inBody < first)) first = inBody
        }
        if (!score) continue
        const start = Math.max(0, first - 80)
        hits.push({ topic, score, excerpt: first < 0 ? topic.summary.slice(0, 300) : topic.body.slice(start, start + 300).replace(/\s+/g, ' ').trim() })
    }
    return hits.sort((a, b) => b.score - a.score || a.topic.id.localeCompare(b.topic.id)).slice(0, Math.max(1, Math.min(limit, 20)))
}
