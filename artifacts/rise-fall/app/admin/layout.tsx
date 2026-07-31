import { AdminThemeProvider } from './theme-provider';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <AdminThemeProvider>
      <div className="h-dvh overflow-y-auto overflow-x-hidden">
        {children}
      </div>
    </AdminThemeProvider>
  );
}
