'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import styles from './workspace-launcher.module.css';

export default function WorkspaceLauncher() {
  const path = usePathname();
  if (path.startsWith('/auth') || path.startsWith('/warehouse') || path === '/os') return null;
  return <Link href="/os" aria-label="Switch operating system" className={styles.launcher}>⇄ Switch OS</Link>;
}
