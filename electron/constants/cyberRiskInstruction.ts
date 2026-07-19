/**
 * 网络安全风险指令
 *
 * 定义 AI 在处理安全相关请求时的行为边界。
 * 注入到系统提示词中。
 */

export const CYBER_RISK_INSTRUCTION =
  "IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.";
