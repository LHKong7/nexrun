export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: { extend: { ringWidth: { 3: '3px' }, boxShadow: { xs: '0 1px 2px 0 rgb(0 0 0 / 0.05)' }, colors: {
    background: 'var(--background)', foreground: 'var(--foreground)',
    card: { DEFAULT: 'var(--card)', foreground: 'var(--card-foreground)' },
    popover: { DEFAULT: 'var(--popover)', foreground: 'var(--popover-foreground)' },
    primary: { DEFAULT: 'var(--primary)', foreground: 'var(--primary-foreground)' },
    secondary: { DEFAULT: 'var(--secondary)', foreground: 'var(--secondary-foreground)' },
    muted: { DEFAULT: 'var(--muted)', foreground: 'var(--muted-foreground)' },
    accent: { DEFAULT: 'var(--accent)', foreground: 'var(--accent-foreground)' },
    sidebar: { DEFAULT: 'var(--sidebar)', foreground: 'var(--sidebar-foreground)', primary: 'var(--sidebar-primary)', 'primary-foreground': 'var(--sidebar-primary-foreground)', accent: 'var(--sidebar-accent)', 'accent-foreground': 'var(--sidebar-accent-foreground)', border: 'var(--sidebar-border)', ring: 'var(--sidebar-ring)' },
    destructive: 'var(--destructive)', border: 'var(--border)', input: 'var(--input)', ring: 'var(--ring)',
  } } },
};
