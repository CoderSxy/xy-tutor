import { useState, type FormEvent } from "react";
import type { KnowledgeItemDTO } from "../../../../../packages/contracts/src/knowledge-base.js";
import type { SkillDTO } from "../../../../../packages/contracts/src/question-bank.js";
import { useAuth } from "../../lib/auth";
import { errorMessage } from "../../lib/api";
import { useRemote } from "../../lib/useRemote";
import { Button } from "../../components/ui/button";
import { Field, Input, Select } from "../../components/ui/field";
import { StatusPanel } from "../../components/StatusPanel";
import { statusLabel } from "../../features/question-bank/labels";
import {
  createSkill,
  linkSkillContent,
  setPrerequisites,
  useSkills,
} from "../../features/question-bank/api";

type KnowledgeList = { items: KnowledgeItemDTO[]; total: number };

export function LearningSkills() {
  const a = useAuth();
  const skills = useSkills();
  const knowledge = useRemote<KnowledgeList>(
    "/api/admin/knowledge/items?status=published&limit=100",
  );
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<string>();
  const [prerequisiteIds, setPrerequisiteIds] = useState<string[]>([]);
  const [linking, setLinking] = useState<string>();
  const [knowledgeItemId, setKnowledgeItemId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  if (a.session?.actor.role !== "admin")
    return <StatusPanel state="error" title="需要管理员权限" />;

  const reload = () => {
    skills.reload();
    knowledge.reload();
  };

  const submitSkill = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await createSkill({ code: code.trim(), name: name.trim() });
      setCode("");
      setName("");
      setStatus("技能已创建");
      reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const openPrerequisites = (skill: SkillDTO) => {
    setLinking(undefined);
    setEditing(skill.id);
    setPrerequisiteIds(skill.prerequisiteIds);
  };

  const savePrerequisites = async (skill: SkillDTO) => {
    setError("");
    try {
      await setPrerequisites(
        skill.id,
        prerequisiteIds.filter((id) => id !== skill.id),
      );
      setEditing(undefined);
      setStatus("前置技能已保存");
      reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const submitLink = async (skill: SkillDTO) => {
    setError("");
    try {
      await linkSkillContent(skill.id, knowledgeItemId);
      setLinking(undefined);
      setKnowledgeItemId("");
      setStatus("知识点已关联");
      reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const items = skills.data ?? [];

  return (
    <>
      <div className="section-head">
        <div className="page-heading">
          <h1>学习技能</h1>
          <p>
            技能用于描述可练习的能力。只有启用中的技能，其已发布题目才会进入学生推荐。
          </p>
        </div>
      </div>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {status && <p role="status">{status}</p>}
      <section className="panel">
        <div className="section-head">
          <h2>新建技能</h2>
        </div>
        <form className="form-stack" onSubmit={submitSkill}>
          <Field
            label="技能代码"
            hint="小写字母、数字和下划线，例如 fraction_add。"
          >
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="fraction_add"
              required
            />
          </Field>
          <Field label="技能名称">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="分数加法"
              required
            />
          </Field>
          <div className="form-actions">
            <Button type="submit" disabled={busy || !code.trim() || !name.trim()}>
              {busy ? "正在创建…" : "创建技能"}
            </Button>
          </div>
        </form>
      </section>
      <section className="panel section-spacer">
        <div className="section-head">
          <h2>技能列表</h2>
          <span className="muted text-small">共 {items.length} 个</span>
        </div>
        {skills.loading && !skills.data ? (
          <StatusPanel state="loading" title="正在读取技能" />
        ) : skills.error ? (
          <StatusPanel
            state="error"
            title={skills.error}
            onRetry={skills.reload}
          />
        ) : items.length ? (
          items.map((skill) => (
            <div className="list-row" key={skill.id}>
              <div className="grow">
                <h3>
                  {skill.name} <small className="muted">{skill.code}</small>
                </h3>
                <p className="muted text-small">
                  前置技能{" "}
                  {skill.prerequisiteIds.length
                    ? skill.prerequisiteIds
                        .map(
                          (id) =>
                            items.find((item) => item.id === id)?.name ?? id,
                        )
                        .join("、")
                    : "无"}
                </p>
              </div>
              <span className="badge">{statusLabel(skill.status)}</span>
              <div className="row-actions">
                <Button
                  variant="outline"
                  onClick={() => openPrerequisites(skill)}
                >
                  编辑前置
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setEditing(undefined);
                    setLinking(linking === skill.id ? undefined : skill.id);
                  }}
                >
                  关联知识点
                </Button>
              </div>
              {editing === skill.id && (
                <div className="panel section-spacer">
                  <Field
                    label="前置技能"
                    hint="学生需要先完成的前置技能；不选表示没有前置。"
                  >
                    <div className="form-stack">
                      {items
                        .filter((item) => item.id !== skill.id)
                        .map((item) => (
                          <label className="checkline" key={item.id}>
                            <input
                              type="checkbox"
                              checked={prerequisiteIds.includes(item.id)}
                              onChange={() =>
                                setPrerequisiteIds((current) =>
                                  current.includes(item.id)
                                    ? current.filter((id) => id !== item.id)
                                    : [...current, item.id],
                                )
                              }
                            />
                            {item.name}
                          </label>
                        ))}
                      {items.length <= 1 && (
                        <p className="muted">还没有其他技能可以作为前置。</p>
                      )}
                    </div>
                  </Field>
                  <div className="form-actions">
                    <Button onClick={() => void savePrerequisites(skill)}>
                      保存前置
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setEditing(undefined)}
                    >
                      取消
                    </Button>
                  </div>
                </div>
              )}
              {linking === skill.id && (
                <div className="panel section-spacer">
                  <Field
                    label="关联知识点"
                    hint="只有已发布的知识点可以关联，关联后题目才有依据。"
                  >
                    <Select
                      value={knowledgeItemId}
                      onChange={(e) => setKnowledgeItemId(e.target.value)}
                    >
                      <option value="">选择知识点</option>
                      {(knowledge.data?.items ?? []).map((item) => (
                        <option value={item.id} key={item.id}>
                          {item.title}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <div className="form-actions">
                    <Button
                      disabled={!knowledgeItemId}
                      onClick={() => void submitLink(skill)}
                    >
                      保存关联
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setLinking(undefined);
                        setKnowledgeItemId("");
                      }}
                    >
                      取消
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))
        ) : (
          <StatusPanel title="还没有技能">
            先创建一个技能，再关联知识点和题目。
          </StatusPanel>
        )}
      </section>
    </>
  );
}
