import { useState } from "react";
import { AppShell } from "./AppShell";
import { Button } from "./ui/button";
import { StatusPanel } from "./StatusPanel";
import { NextActions } from "./NextActions";
import { QuestionCard } from "./QuestionCard";
export function DesignPreview() {
  const [working, setWorking] = useState(false);
  return (
    <AppShell context="人教版 · 五年级 · 数学 · 下册">
      <p className="preview-note">组件预览（非学习记录）</p>
      <div className="page-heading">
        <h1>今天，从哪里开始？</h1>
        <p>选一个小目标，一步一步学明白。</p>
      </div>
      <div className="welcome-layout">
        <section>
          <div className="start-panel">
            <h2>每天一点，学得更扎实。</h2>
            <p>根据你的教材和当前进度，逐题练习，及时发现还没弄懂的地方。</p>
            <Button onClick={() => setWorking(true)}>开始每日5练</Button>
          </div>
          {working && <StatusPanel state="loading" title="正在准备练习" />}
          <div className="study-ways">
            <NextActions
              actions={[
                { id: "knowledge", label: "知识点巩固" },
                { id: "mistake", label: "错题回顾" },
                { id: "upload", label: "上传题目 / 试卷" },
              ]}
              onSelect={() => setWorking(true)}
            />
          </div>
        </section>
        <QuestionCard
          question={{
            stem: "公式排版示例：\n\n$$\\frac{1}{2}+\\frac{1}{3}=\\frac{3+2}{6}$$\n\n先观察分母，再想一想怎样找到公分母。",
            knowledgePoint: "分数",
          }}
        />
      </div>
    </AppShell>
  );
}
