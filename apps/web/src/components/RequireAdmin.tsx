import { Outlet } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { StatusPanel } from "./StatusPanel";

export function RequireAdmin() {
  const auth = useAuth();
  if (auth.loading)
    return <StatusPanel state="loading" title="正在校验管理员权限" />;
  if (auth.session?.actor.role !== "admin")
    return (
      <StatusPanel state="error" title="需要管理员权限">
        <p>当前账号没有查看学生学情档案的权限。</p>
      </StatusPanel>
    );
  return <Outlet />;
}
