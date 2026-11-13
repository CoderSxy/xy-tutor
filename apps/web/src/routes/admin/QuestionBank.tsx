import { useState, type FormEvent } from "react";
import type { KnowledgeItemDTO } from "../../../../../packages/contracts/src/knowledge-base.js";
import type { QuestionBankEntrySummaryDTO } from "../../../../../packages/contracts/src/question-bank.js";
import { useAuth } from "../../lib/auth";
import { errorMessage } from "../../lib/api";
import { useRemote } from "../../lib/useRemote";
import { Button } from "../../components/ui/button";
import { Field, Input, Select, Textarea } from "../../components/ui/field";
import { StatusPanel } from "../../components/StatusPanel";
import {
  difficultyLabels,
  entryStatusLabels,
  sourceTypeLabels,
  templateStatusLabels,
  verificationLabels,
} from "../../features/question-bank/labels";
import {
  createQuestion,
  publishEntry,
  reviewTemplate,
  useQuestionEntries,
  useQuestionTemplates,
  useSkills,
  withdrawEntry,
} from "../../features/question-bank/api";

type KnowledgeList = { items: KnowledgeItemDTO[]; total: number };

export function QuestionBank() {
  const a = useAuth();
  const skills = useSkills();
  const knowledge = useRemote<KnowledgeList>(
    "/api/admin/knowledge/items?status=published&limit=100",
  );
  const [statusFilter, setStatusFilter] = useState("");
  const entries = useQuestionEntries(statusFilter || undefined);
  const templates = useQuestionTemplates();
  const [skillId, setSkillId] = useState("");
  const [stem, setStem] = useState("");
  const [referenceAnswer, setReferenceAnswer] = useState("");
  const [difficultyBand, setDifficultyBand] = useState("easy");
  const [complexityBand, setComplexityBand] = useState("1");
  const [sourceType, setSourceType] = useState("shared_upload");
  const [sourceRef, setSourceRef] = useState("");
  const [knowledgeItemId, setKnowledgeItemId] = useState("");
  const [withdrawing, setWithdrawing] = useState<string>();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  if (a.session?.actor.role !== "admin")
    return <StatusPanel state="error" title="需要管理员权限" />;

  const reload = () => {
    entries.reload();
    templates.reload();
  };

  const submitQuestion = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await createQuestion({
        skillId,
        stem: stem.trim(),
        referenceAnswer: referenceAnswer.trim(),
        difficultyBand: difficultyBand as "easy" | "medium" | "challenge",
        complexityBand: Number(complexityBand),
        sourceType: sourceType as
          | "private_upload"
          | "shared_upload"
          | "template"
          | "generated",
        ...(sourceRef.trim() ? { sourceRef: sourceRef.trim() } : {}),
        ...(knowledgeItemId ? { knowledgeItemId } : {}),
      });
      setStem("");
      setReferenceAnswer("");
      setSourceRef("");
      setStatus("题目已提交审核");
      reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const publish = async (entry: QuestionBankEntrySummaryDTO) => {
    setError("");
    try {
      await publishEntry(entry.id, entry.version);
      setStatus("题目已发布");
      reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const withdraw = async (entry: QuestionBankEntrySummaryDTO) => {
    setError("");
    try {
      await withdrawEntry(entry.id, reason.trim());
      setWithdrawing(undefined);
      setReason("");
      setStatus("题目已撤回，不再进入新推荐");
      reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const review = async (
    templateId: string,
    decision: "approved" | "rejected",
  ) => {
    setError("");
    try {
      await reviewTemplate(templateId, decision);
      setStatus(decision === "approved" ? "模板已批准" : "模板已驳回");
      templates.reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const activeSkills = (skills.data ?? []).filter(
    (skill) => skill.status === "active",
  );

  return (
    <>
      <div className="section-head">
        <div className="page-heading">
          <h1>题库</h1>
          <p>
            待审核题目与未发布的模板不会进入学生推荐。撤回会立即停止新的推荐，已发出的题目保留记录。
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
          <h2>新增题目</h2>
        </div>
        {activeSkills.length ? (
          <form className="form-stack" onSubmit={submitQuestion}>
            <Field label="所属技能">
              <Select
                value={skillId}
                onChange={(e) => setSkillId(e.target.value)}
                required
              >
                <option value="">选择技能</option>
                {activeSkills.map((skill) => (
                  <option value={skill.id} key={skill.id}>
                    {skill.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="题干">
              <Textarea
                value={stem}
                onChange={(e) => setStem(e.target.value)}
                placeholder="例如：计算 3/8 + 1/8"
                required
              />
            </Field>
            <Field label="参考答案">
              <Textarea
                value={referenceAnswer}
                onChange={(e) => setReferenceAnswer(e.target.value)}
                placeholder="例如：1/2"
                required
              />
            </Field>
            <div className="row-actions">
              <Field label="难度">
                <Select
                  value={difficultyBand}
                  onChange={(e) => setDifficultyBand(e.target.value)}
                >
                  <option value="easy">基础</option>
                  <option value="medium">进阶</option>
                  <option value="challenge">挑战</option>
                </Select>
              </Field>
              <Field label="步骤复杂度">
                <Select
                  value={complexityBand}
                  onChange={(e) => setComplexityBand(e.target.value)}
                >
                  <option value="1">1 步</option>
                  <option value="2">2 步</option>
                  <option value="3">3 步</option>
                </Select>
              </Field>
            </div>
            <div className="row-actions">
              <Field label="来源">
                <Select
                  value={sourceType}
                  onChange={(e) => setSourceType(e.target.value)}
                >
                  <option value="shared_upload">共享上传</option>
                  <option value="private_upload">私人上传</option>
                  <option value="template">模板生成</option>
                  <option value="generated">模型生成</option>
                </Select>
              </Field>
              <Field label="来源说明（可选）">
                <Input
                  value={sourceRef}
                  onChange={(e) => setSourceRef(e.target.value)}
                  placeholder="例如：教材第三章例题"
                />
              </Field>
            </div>
            <Field
              label="依据知识点（可选）"
              hint="选择后题目会关联到该技能已关联的知识点。"
            >
              <Select
                value={knowledgeItemId}
                onChange={(e) => setKnowledgeItemId(e.target.value)}
              >
                <option value="">不指定</option>
                {(knowledge.data?.items ?? []).map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.title}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="form-actions">
              <Button
                type="submit"
                disabled={
                  busy ||
                  !skillId ||
                  !stem.trim() ||
                  !referenceAnswer.trim()
                }
              >
                {busy ? "正在提交…" : "提交审核"}
              </Button>
            </div>
          </form>
        ) : (
          <StatusPanel title="还没有启用的技能">
            先在“学习技能”里创建并关联知识点，再添加题目。
          </StatusPanel>
        )}
      </section>
      <section className="panel section-spacer">
        <div className="section-head">
          <h2>题目条目</h2>
          <Field label="状态筛选">
            <Select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">全部</option>
              <option value="pending_review">待审核</option>
              <option value="published">已发布</option>
              <option value="withdrawn">已撤回</option>
            </Select>
          </Field>
        </div>
        {entries.loading && !entries.data ? (
          <StatusPanel state="loading" title="正在读取题目" />
        ) : entries.error ? (
          <StatusPanel
            state="error"
            title={entries.error}
            onRetry={entries.reload}
          />
        ) : entries.data?.items.length ? (
          entries.data.items.map((entry) => (
            <div className="list-row" key={entry.id}>
              <div className="grow">
                <h3>{entry.stem}</h3>
                <p className="muted text-small">
                  {entry.skillName} · {difficultyLabels[entry.difficultyBand]} ·
                  步骤复杂度 {entry.complexityBand} · 来源{" "}
                  {sourceTypeLabels[entry.sourceType] ?? entry.sourceType}
                  {entry.sourceRef ? `（${entry.sourceRef}）` : ""} ·{" "}
                  {verificationLabels[entry.verification] ?? entry.verification}
                  {entry.templateFamily
                    ? ` · 模板 ${entry.templateFamily}`
                    : ""}
                </p>
                {withdrawing === entry.id && (
                  <Field label="撤回原因" hint="撤回后该题不再进入新的推荐。">
                    <Input
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="例如：答案有误，需要重新核验"
                    />
                  </Field>
                )}
              </div>
              <span className="badge">
                {entryStatusLabels[entry.status] ?? entry.status}
              </span>
              <div className="row-actions">
                {entry.status === "pending_review" && (
                  <Button onClick={() => void publish(entry)}>发布</Button>
                )}
                {entry.status !== "withdrawn" &&
                  (withdrawing === entry.id ? (
                    <>
                      <Button
                        disabled={!reason.trim()}
                        onClick={() => void withdraw(entry)}
                      >
                        确认撤回
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setWithdrawing(undefined);
                          setReason("");
                        }}
                      >
                        取消
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setReason("");
                        setWithdrawing(entry.id);
                      }}
                    >
                      撤回
                    </Button>
                  ))}
              </div>
            </div>
          ))
        ) : (
          <StatusPanel
            title={statusFilter ? "没有符合条件的题目" : "题库还是空的"}
          >
            {statusFilter
              ? "换一个状态试试。"
              : "先新增一道题目，审核通过后发布。"}
          </StatusPanel>
        )}
      </section>
      <section className="panel section-spacer">
        <div className="section-head">
          <h2>题目模板</h2>
          <span className="muted text-small">
            待审核 {templates.data?.items.filter((t) => t.status === "pending_review").length ?? 0} 个
          </span>
        </div>
        {templates.loading && !templates.data ? (
          <StatusPanel state="loading" title="正在读取模板" />
        ) : templates.error ? (
          <StatusPanel
            state="error"
            title={templates.error}
            onRetry={templates.reload}
          />
        ) : templates.data?.items.length ? (
          templates.data.items.map((template) => (
            <div className="list-row" key={template.id}>
              <div className="grow">
                <h3>{template.family}</h3>
                <p className="muted text-small">
                  {difficultyLabels[template.difficultyBand]} · 版本{" "}
                  {template.version}
                  {template.skillId
                    ? ` · 技能 ${
                        skills.data?.find((s) => s.id === template.skillId)
                          ?.name ?? template.skillId
                      }`
                    : ""}
                  {template.approvedAt
                    ? ` · 批准于 ${new Date(template.approvedAt).toLocaleString()}`
                    : ""}
                </p>
              </div>
              <span className="badge">
                {templateStatusLabels[template.status] ?? template.status}
              </span>
              {template.status === "pending_review" && (
                <div className="row-actions">
                  <Button
                    onClick={() => void review(template.id, "approved")}
                  >
                    批准
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void review(template.id, "rejected")}
                  >
                    驳回
                  </Button>
                </div>
              )}
            </div>
          ))
        ) : (
          <StatusPanel title="还没有题目模板">
            模板生成的新题会先到这里等待审核。
          </StatusPanel>
        )}
      </section>
    </>
  );
}
