/**
 * 退出状态标记（SY-03 托盘常驻）：
 * “关闭主窗口最小化到托盘”与“真正退出”共用 close 事件，
 * 通过该标记区分——用户从托盘/菜单选择“退出”时先置位，再 app.quit()。
 */

let quitting = false;

export function setQuitting(): void {
  quitting = true;
}

export function isQuitting(): boolean {
  return quitting;
}
