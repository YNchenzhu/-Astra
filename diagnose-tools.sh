#!/bin/bash
# 工具定义诊断脚本

echo "=== Cursor UI Clone 工具定义诊断 ==="
echo ""

# 检查工具注册文件
echo "1. 检查工具注册文件..."
if grep -q "const builtinTools: Tool\[\]" "electron/tools/registry.ts"; then
  echo "   ✓ 工具定义数组存在"
  TOOL_COUNT=$(grep -c "name: '" "electron/tools/registry.ts")
  echo "   ✓ 找到 $TOOL_COUNT 个工具定义"
else
  echo "   ✗ 工具定义数组不存在"
fi

echo ""
echo "2. 检查工具注册..."
if grep -q "class ToolRegistry" "electron/tools/registry.ts"; then
  echo "   ✓ ToolRegistry 类存在"
  if grep -q "for (const tool of builtinTools)" "electron/tools/registry.ts"; then
    echo "   ✓ 工具在构造函数中注册"
  else
    echo "   ✗ 工具未在构造函数中注册"
  fi
else
  echo "   ✗ ToolRegistry 类不存在"
fi

echo ""
echo "3. 检查工具定义转换..."
if grep -q "export function getToolDefinitions" "electron/tools/schema.ts"; then
  echo "   ✓ getToolDefinitions() 函数存在"
else
  echo "   ✗ getToolDefinitions() 函数不存在"
fi

echo ""
echo "4. 检查 AI 客户端集成..."
if grep -q "tools?: Array" "electron/ai/client.ts"; then
  echo "   ✓ streamText() 接收工具参数"
else
  echo "   ✗ streamText() 未接收工具参数"
fi

echo ""
echo "5. 检查 Agentic 循环..."
if grep -q "getToolDefinitions()" "electron/ai/agenticLoop.ts"; then
  echo "   ✓ Agentic 循环调用 getToolDefinitions()"
else
  echo "   ✗ Agentic 循环未调用 getToolDefinitions()"
fi

echo ""
echo "6. 检查 IPC 暴露..."
if grep -q "tool:list" "electron/preload.ts"; then
  echo "   ✓ 工具列表 API 已暴露"
else
  echo "   ✗ 工具列表 API 未暴露"
fi

echo ""
echo "=== 诊断完成 ==="
