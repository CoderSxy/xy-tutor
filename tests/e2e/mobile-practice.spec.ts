import { test, expect, type Page } from "@playwright/test";
import { mockLearningApi } from "./fixtures/ui-api";

const viewports = [
  { width: 320, height: 740 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
];

async function login(page: Page) {
  await page.getByLabel("账号", { exact: true }).fill("student");
  await page.getByLabel("密码", { exact: true }).fill("long-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
}

async function noHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    )
    .toBe(true);
}

test.describe("mobile practice layout", () => {
  for (const viewport of viewports) {
    test(`${viewport.width}x${viewport.height} keeps study usable`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await mockLearningApi(page, "student", { practiceSets: true });
      await page.goto("/");
      await login(page);
      await expect(page.getByRole("button", { name: "每日5练" })).toBeVisible();
      await expect(page.getByRole("button", { name: "错题回顾" })).toBeVisible();
      await expect(page.getByRole("button", { name: "拍照问老师" })).toBeVisible();
      await expect(page.getByRole("button", { name: "知识点巩固" })).toBeVisible();
      await noHorizontalOverflow(page);

      await page.getByRole("button", { name: "每日5练" }).click();
      await expect(page).toHaveURL(/\/study\//);
      await expect(page.getByRole("heading", { name: "第 1 题" })).toBeVisible();
      await expect(page.getByRole("link", { name: "返回" })).toBeVisible();
      if (viewport.width < 768) {
        await expect(page.getByRole("navigation", { name: "底部导航" })).toHaveCount(
          0,
        );
      }
      await noHorizontalOverflow(page);
      const tooSmall = await page.evaluate(() => {
        const nodes = [...document.querySelectorAll("button, a.button, .tab-bar a")];
        return nodes
          .filter((node) => {
            if (node.classList.contains("skip-link")) return false;
            const style = window.getComputedStyle(node);
            if (style.display === "none" || style.visibility === "hidden")
              return false;
            const box = node.getBoundingClientRect();
            return box.width > 0 && box.height > 0 && (box.width < 44 || box.height < 44);
          })
          .map((node) => (node as HTMLElement).innerText || node.getAttribute("aria-label"));
      });
      expect(tooSmall).toEqual([]);
    });
  }

  test("soft keyboard resize does not cover the send control", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockLearningApi(page, "student", { practiceSets: true });
    await page.goto("/");
    await login(page);
    await page.getByRole("button", { name: "每日5练" }).click();
    await expect(page.getByLabel("你的回答")).toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
      const visual = {
        width: 390,
        height: 480,
        offsetTop: 0,
        addEventListener: () => {},
        removeEventListener: () => {},
      };
      Object.defineProperty(window, "visualViewport", {
        configurable: true,
        value: visual,
      });
      window.dispatchEvent(new Event("resize"));
    });
    const send = page.getByRole("button", { name: "发送消息" });
    await expect(send).toBeVisible();
    const box = await send.boundingBox();
    expect(box).toBeTruthy();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(844);
  });
});
