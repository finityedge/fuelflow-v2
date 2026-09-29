import { Link } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore.js';
import { canUpload, canCorrect } from '../lib/rbac.js';
import { Layout } from '../components/Layout.js';
import { PageHeading } from '../components/PageHeading.js';
import { UploadIcon, ReportsIcon, ChevronRightIcon, CheckIcon } from '../components/icons.js';

export function Home() {
  const user = useAuthStore((state) => state.user);

  const uploadAllowed = user ? canUpload(user.role) : false;
  const correctAllowed = user ? canCorrect(user.role) : false;

  // No "manage team" entry: there is no /team route, no team API and no screen behind it,
  // and the link used to render an empty page. It goes back in when the feature does.
  const quickActions = [
    {
      title: 'Upload shift report',
      description: 'Drop a PDF for your assigned station.',
      icon: UploadIcon,
      to: '/upload',
      allowed: uploadAllowed,
      color: 'bg-primary-subtle text-primary',
    },
    {
      title: 'Review reports',
      description: 'Approve or edit extracted fields.',
      icon: ReportsIcon,
      to: '/shift-reports/recent',
      allowed: correctAllowed,
      color: 'bg-success-subtle text-success',
    },
  ];

  const stats = [
    { label: 'Assigned stations', value: user?.stationIds?.length ?? 0 },
    { label: 'Role', value: user?.role ?? '—' },
    { label: 'Tenant', value: user?.tenantId ? user.tenantId.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') : '—' },
  ];

  return (
    <Layout>
      <div className="mx-auto max-w-6xl space-y-6">
        <PageHeading
          title="Dashboard"
          actions={
            <>
              {uploadAllowed && (
                <Link to="/upload" className="btn-primary">
                  <UploadIcon className="h-4 w-4" />
                  Upload report
                </Link>
              )}
              <Link to="/shift-reports/recent" className="btn-secondary">
                View reports
                <ChevronRightIcon className="h-4 w-4" />
              </Link>
            </>
          }
        />

        {/* Welcome banner */}
        <div className="card relative overflow-hidden p-6 sm:p-8">
          <div className="absolute right-0 top-0 h-full w-1/3 bg-gradient-to-l from-primary/5 to-transparent" />
          <div className="relative">
            <h2 className="text-xl sm:text-2xl font-bold text-body mb-2">
              Welcome back, {user?.email.split('@')[0] ?? 'User'}
            </h2>
            <p className="text-muted max-w-xl">
              Upload a shift report and we will read the figures out of it, so the only thing
              left to do is check the ones we flag.
            </p>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {stats.map((stat) => (
            <div key={stat.label} className="card p-5">
              <p className="text-sm font-medium text-muted mb-1">{stat.label}</p>
              <p className="text-2xl font-bold text-body">{stat.value}</p>
            </div>
          ))}
        </div>

        {/* Quick actions */}
        <div>
          <h3 className="text-lg font-bold text-body mb-4">Quick actions</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {quickActions
              .filter((a) => a.allowed)
              .map((action) => {
                const Icon = action.icon;
                return (
                  <Link
                    key={action.title}
                    to={action.to}
                    className="group card p-5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-card-hover hover:border-primary/20"
                  >
                    <div className={`mb-4 inline-flex h-11 w-11 items-center justify-center rounded-xl ${action.color}`}>
                      <Icon className="h-5 w-5" />
                    </div>
                    <h4 className="font-bold text-body group-hover:text-primary transition-colors">
                      {action.title}
                    </h4>
                    <p className="mt-1 text-sm text-muted">{action.description}</p>
                  </Link>
                );
              })}
          </div>
        </div>

        {/* Getting started checklist */}
        <div className="card p-5 sm:p-6">
          <h3 className="text-lg font-bold text-body mb-4">Getting started</h3>
          <div className="space-y-3">
            {[
              { text: 'Upload your first shift report PDF', done: false },
              { text: 'Review extracted fields for accuracy', done: false },
              { text: 'Invite managers and attendants to your station', done: false },
            ].map((item, i) => (
              <div
                key={i}
                className={`flex items-center gap-3 rounded-xl p-3 ${item.done ? 'bg-success-subtle/50' : 'bg-slate-50'}`}
              >
                <div
                  className={`flex h-6 w-6 items-center justify-center rounded-full ${
                    item.done ? 'bg-success text-white' : 'bg-surface border-2 border-border'
                  }`}
                >
                  {item.done && <CheckIcon className="h-3.5 w-3.5" />}
                </div>
                <span className={`text-sm ${item.done ? 'text-body font-medium' : 'text-muted'}`}>{item.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Layout>
  );
}
