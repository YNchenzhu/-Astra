#!/bin/bash
# 验证所有工具定义的 items 字段

echo "=== 工具定义 items 字段验证 ==="
echo ""

# 检查 AskUserQuestionTool
echo "1. 检查 AskUserQuestionTool..."
if grep -A 5 "name: 'questions'" electron/tools/AskUserQuestionTool.ts | grep -q "items:"; then
  echo "   ✓ questions 参数有 items 定义"
else
  echo "   ✗ questions 参数缺少 items 定义"
fi

if grep -A 5 "name: 'metadata'" electron/tools/AskUserQuestionTool.ts | grep -q "items:"; then
  echo "   ✓ metadata 参数有 items 定义"
else
  echo "   ✗ metadata 参数缺少 items 定义"
fi

echo ""
echo "2. 检查 ExitPlanModeTool..."
if grep -A 5 "name: 'allowedPrompts'" electron/tools/ExitPlanModeTool.ts | grep -q "items:"; then
  echo "   ✓ allowedPrompts 参数有 items 定义"
else
  echo "   ✗ allowedPrompts 参数缺少 items ���义"
fi

echo ""
echo "3. 检查 schema.ts 中的 items 处理..."
if grep -q "if (param.items)" electron/tools/schema.ts; then
  echo "   ✓ schema.ts 处理 items 字段"
else
  echo "   ✗ schema.ts 未处理 items 字段"
fi

echo ""
echo "4. 检查 client.ts 中的 ensureArrayItemsSchema..."
if grep -q "function ensureArrayItemsSchema" electron/ai/client.ts; then
  echo "   ✓ client.ts 有 ensureArrayItemsSchema 函数"
else
  echo "   ✗ client.ts 缺少 ensureArrayItemsSchema 函数"
fi

echo ""
echo "5. 检查各提供商是否使用 ensureArrayItemsSchema..."
if grep -q "ensureArrayItemsSchema" electron/ai/client.ts; then
  USAGE_COUNT=$(grep -c "ensureArrayItemsSchema" electron/ai/client.ts)
  echo "   ✓ ensureArrayItemsSchema 被使用 $USAGE_COUNT 次"

  if grep "convertToolsToOpenAIFormat" electron/ai/client.ts | grep -q "ensureArrayItemsSchema"; then
    echo "   ✓ OpenAI 使用 ensureArrayItemsSchema"
  else
    echo "   ✗ OpenAI 未使用 ensureArrayItemsSchema"
  fi

  if grep "convertToolsToGeminiFormat" electron/ai/client.ts | grep -q "ensureArrayItemsSchema"; then
    echo "   ✓ Gemini 使用 ensureArrayItemsSchema"
  else
    echo "   ✗ Gemini 未使用 ensureArrayItemsSchema"
  fi

  if grep "requestParams.tools" electron/ai/client.ts | grep -q "ensureArrayItemsSchema"; then
    echo "   ✓ Anthropic 使用 ensureArrayItemsSchema"
  else
    echo "   ✗ Anthropic 未使用 ensureArrayItemsSchema"
  fi
else
  echo "   ✗ ensureArrayItemsSchema 未被使用"
fi

echo ""
echo "=== 验证完成 ==="
