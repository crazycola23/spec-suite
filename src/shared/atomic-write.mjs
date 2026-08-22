// 原子写：仓库里四套写策略的并集。
//
// 合并前四处各写一遍，而且各缺一块 —— 缺的还不是同一块：
//
//   | 写点                                            | 每文件原子 | 多文件全有或全无 | temp 清理 | temp 名     |
//   |-------------------------------------------------|-----------|-----------------|----------|-------------|
//   | generate-contract-bundle `writeAllAfterValidation` | ✗ 直写目标 | ✓ 内存快照回滚   | 无 temp   | —           |
//   | migrate-unresolved `writePreparedFiles`           | ✓         | ✗ rename 中途失败无回滚 | ✗    | Math.random |
//   | control-plane-common `writeJsonAtomic`            | ✓         | — 单文件         | ✓ finally | randomUUID  |
//   | render-docs `applyDocPlan`                        | ✓         | ✗               | ✗        | **固定名**   |
//
// 最后一行那个"固定名"值得单独说：`${abs}.tmp-render` 不带 pid 也不带随机
// 数，两个并发的 render-docs 会写同一个 temp，互相覆盖之后各自 rename ——
// 结果是其中一个的输出静默变成另一个的。它旁边还有一句注释写着"与仓库其它
// 写点一致：先写 tmp 再 rename"，而事实上 generate-contract-bundle 根本没有
// temp。注释本身就是漂移的证据。
//
// 并集语义（每一列都取四者里最强的那个）：
//
//   1. 每文件先写 temp 再 rename —— 目标文件永远不处于半写状态
//   2. **两阶段**：所有 temp 写完才开始 rename。磁盘满、权限、序列化异常这类
//      失败发生在阶段一，此时目标一个都没被动过
//   3. rename 阶段中途失败 ⇒ 用阶段零的快照把已 rename 的目标还原回去
//   4. temp 名带 pid + randomUUID，消掉上面那个并发覆盖
//   5. 无论成败，finally 清掉所有残留 temp
//
// **有意不做 fsync**：四处原来都没有。rename 在 POSIX 上对"可见性"是原子的，
// 对"掉电之后仍然在"不是 —— 这两件事常被混为一谈。本仓库的威胁模型是工具
// 自身的正确性（半份文件、部分写入、并发覆盖），不是掉电，所以这个缺口按
// D5 对 BOM 的处理方式登记进 registry，而不是顺手补上。有意的不统一必须写
// 下来，否则下一个人会以为这里已经保证了耐久性。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * 多文件原子写。要么全部落盘，要么一个都不落。
 *
 * @param {Array<{target: string, content: string}>} files 目标绝对路径与完整内容
 * @param {{mode?: number, skipUnchanged?: boolean}} [options]
 *   `mode` 传给 temp 文件的创建权限（rename 会保留它）；不传则与普通写一致。
 *   `skipUnchanged` = 内容与磁盘上完全相同的文件不写，也不出现在返回值里。
 * @returns {string[]} 实际写入的 target
 */
export function writeFilesAtomic(files, { mode, skipUnchanged = false } = {}) {
  // 阶段零：快照。回滚全靠它，所以必须在动任何东西**之前**采集完。
  const planned = []
  for (const { target, content } of files) {
    const existed = fs.existsSync(target)
    if (skipUnchanged && existed && fs.readFileSync(target, 'utf8') === content) continue
    planned.push({
      target,
      content,
      existed,
      previous: existed ? fs.readFileSync(target) : null,
      temp: `${target}.tmp-${process.pid}-${crypto.randomUUID()}`,
    })
  }

  const renamed = []
  try {
    // 阶段一：全部写 temp。这里抛错 ⇒ 目标一个都没动过，无需回滚。
    for (const file of planned) {
      fs.mkdirSync(path.dirname(file.target), { recursive: true })
      fs.writeFileSync(
        file.temp, file.content,
        mode === undefined ? 'utf8' : { encoding: 'utf8', mode },
      )
    }
    // 阶段二：全部 rename。
    for (const file of planned) {
      fs.renameSync(file.temp, file.target)
      renamed.push(file)
    }
  } catch (error) {
    // 逆序还原已经 rename 的那些；没 rename 的 temp 交给 finally。
    //
    // 逆序在这里**没有**语义作用：阶段零一次性采完全部快照，所以每个
    // target 的 `previous` 都是这批操作之前的字节，正序还原结果完全相同
    // （即便同一批里有两个条目指向同一路径也一样）。保留逆序只是沿用原
    // 实现的写法与"撤销按 LIFO"的惯例 —— 写在这里以免下一个人以为它是
    // 正确性的必要条件，或反过来以为可以顺手改成别的顺序而无需理由。
    for (const file of renamed.reverse()) {
      if (file.existed) fs.writeFileSync(file.target, file.previous)
      else if (fs.existsSync(file.target)) fs.rmSync(file.target, { force: true })
    }
    throw error
  } finally {
    for (const file of planned) {
      if (fs.existsSync(file.temp)) fs.rmSync(file.temp, { force: true })
    }
  }
  return planned.map((file) => file.target)
}

/**
 * 单文件原子写。`writeFilesAtomic` 的退化情形，只是省掉调用方包一层数组。
 *
 * @returns {string} 写入的内容，方便调用方接着做 digest
 */
export function writeFileAtomic(target, content, options = {}) {
  writeFilesAtomic([{ target, content }], options)
  return content
}
