import type { ReactNode } from "react";
import { NavLink, Link, useLocation } from "react-router-dom";
import {
  BookOpen,
  House,
  NotebookPen,
  Files,
  History,
  Settings,
  ShieldCheck,
  Users,
  LogOut,
  UserRound,
} from "lucide-react";
import { Button } from "./ui/button";

const nav = [
  { to: "/", label: "开始学习", icon: House },
  { to: "/mistakes", label: "我的错题", icon: NotebookPen },
  { to: "/materials", label: "学习资料", icon: Files },
  { to: "/history", label: "学习记录", icon: History },
  { to: "/profile", label: "个人设置", icon: Settings },
];

const adminNav = [
  { to: "/admin/students", label: "学生学情", icon: Users },
  { to: "/admin/knowledge", label: "知识点", icon: ShieldCheck },
  { to: "/admin/accounts", label: "账号管理", icon: Settings },
];

const studentTabs = [
  { to: "/", label: "学习", icon: House },
  { to: "/mistakes", label: "错题", icon: NotebookPen },
  { to: "/materials", label: "资料", icon: Files },
  { to: "/history", label: "记录", icon: History },
  { to: "/profile", label: "我的", icon: UserRound },
];

const adminTabs = [
  { to: "/", label: "学习", icon: House },
  { to: "/admin/students", label: "学情", icon: Users },
  { to: "/admin/knowledge", label: "知识点", icon: ShieldCheck },
  { to: "/admin/accounts", label: "账号", icon: Settings },
  { to: "/profile", label: "我的", icon: UserRound },
];

const titles: [string, string][] = [
  ["/admin/students", "学生学情"],
  ["/admin/knowledge", "知识点"],
  ["/admin/accounts", "账号管理"],
  ["/study/", "学习进行中"],
  ["/mistakes", "我的错题"],
  ["/materials", "学习资料"],
  ["/history", "学习记录"],
  ["/profile", "个人设置"],
  ["/", "开始学习"],
];

function pageTitle(pathname: string) {
  const hit = titles.find(([prefix]) =>
    prefix === "/" ? pathname === "/" : pathname.startsWith(prefix),
  );
  return hit ? hit[1] : "XY Tutor";
}

const TODAY = new Intl.DateTimeFormat("zh-CN", {
  month: "long",
  day: "numeric",
  weekday: "long",
});

export function AppShell({
  children,
  mode = "student",
  name = "同学",
  onLogout,
}: {
  children: ReactNode;
  mode?: "student" | "admin";
  name?: string;
  onLogout?: () => void;
}) {
  const { pathname } = useLocation();
  const tabs = mode === "admin" ? adminTabs : studentTabs;
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <aside className="sidebar">
        <Link className="brand" to="/">
          <BookOpen size={20} />
          <span>XY Tutor</span>
        </Link>
        <nav aria-label="主导航">
          <p className="nav-label">学习</p>
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} end={to === "/"} title={label}>
              <Icon size={18} />
              <span>{label}</span>
            </NavLink>
          ))}
          {mode === "admin" && (
            <>
              <p className="nav-label">管理</p>
              {adminNav.map(({ to, label, icon: Icon }) => (
                <NavLink key={to} to={to} title={label}>
                  <Icon size={18} />
                  <span>{label}</span>
                </NavLink>
              ))}
            </>
          )}
        </nav>
        <div className="sidebar-bottom">
          <span className="avatar">{name.slice(0, 1)}</span>
          <span className="account-name">
            {name}
            <small>{mode === "admin" ? "管理员" : "学习账号"}</small>
          </span>
          {onLogout && (
            <Button
              size="icon"
              variant="ghost"
              onClick={onLogout}
              aria-label="退出登录"
            >
              <LogOut size={16} />
            </Button>
          )}
        </div>
      </aside>
      <div className="workspace">
        <header className="context-bar">
          <span className="context-title">{pageTitle(pathname)}</span>
          <span className="context-meta">{TODAY.format(new Date())}</span>
        </header>
        <main id="main-content" className="page-content">
          {children}
        </main>
      </div>
      <nav className="tab-bar" aria-label="底部导航">
        {tabs.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} end={to === "/"} title={label}>
            <Icon size={20} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
