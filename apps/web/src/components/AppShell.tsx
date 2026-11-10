import { useState, type ReactNode } from "react";
import { NavLink, Link } from "react-router-dom";
import {
  BookOpen,
  House,
  NotebookPen,
  Files,
  History,
  Settings,
  Menu,
  ShieldCheck,
  Users,
  LogOut,
} from "lucide-react";
import { Button } from "./ui/button";
const nav = [
  { to: "/", label: "开始学习", icon: House },
  { to: "/mistakes", label: "我的错题", icon: NotebookPen },
  { to: "/materials", label: "学习资料", icon: Files },
  { to: "/history", label: "学习记录", icon: History },
  { to: "/profile", label: "个人设置", icon: Settings },
];
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
  const [open, setOpen] = useState(false);
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <aside className={`sidebar ${open ? "sidebar-open" : ""}`}>
        <Link className="brand" to="/" onClick={() => setOpen(false)}>
          <BookOpen size={27} />
          <span>
            XY Tutor<small>陪你把知识学明白</small>
          </span>
        </Link>
        <nav aria-label="主导航">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              title={label}
              onClick={() => setOpen(false)}
            >
              <Icon size={20} />
              <span>{label}</span>
            </NavLink>
          ))}
          {mode === "admin" && (
            <>
              <div className="nav-divider" />
              <NavLink to="/admin/students" onClick={() => setOpen(false)}>
                <Users size={20} />
                <span>学生学情</span>
              </NavLink>
              <NavLink to="/admin/textbooks" onClick={() => setOpen(false)}>
                <ShieldCheck size={20} />
                <span>教材管理</span>
              </NavLink>
              <NavLink to="/admin/accounts" onClick={() => setOpen(false)}>
                <Settings size={20} />
                <span>账号管理</span>
              </NavLink>
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
              <LogOut size={18} />
            </Button>
          )}
        </div>
      </aside>
      {open && (
        <button
          aria-label="关闭导航"
          className="nav-backdrop"
          onClick={() => setOpen(false)}
        />
      )}
      <div className="workspace">
        <header className="mobile-bar">
          <Button
            className="menu-button"
            variant="ghost"
            size="icon"
            aria-label="展开导航"
            onClick={() => setOpen(!open)}
          >
            <Menu size={22} />
          </Button>
          <span className="mobile-bar-title">XY Tutor</span>
        </header>
        <main id="main-content" className="page-content">
          {children}
        </main>
      </div>
    </div>
  );
}
