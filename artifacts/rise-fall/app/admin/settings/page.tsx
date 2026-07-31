import { AdminLoginForm } from '../quant/login-form';
import { isAdminAuthorized } from '../quant/admin-auth';
import { SettingsPanel } from './settings-panel';

export const dynamic = 'force-dynamic';

export default async function GlobalSettingsPage() {

  if (!await isAdminAuthorized()) {
    return <AdminLoginForm />;
  }

  return <SettingsPanel />;
}
