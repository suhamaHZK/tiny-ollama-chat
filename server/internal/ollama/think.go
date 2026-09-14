package ollama

import "strings"

const (
	thinkOpenTag  = "<think>"
	thinkCloseTag = "</think>"
)

// ThinkParam returns the Ollama `think` request value and whether it should
// be sent. Unknown and completion-only models omit the field entirely
// (ok=false) so Ollama does not reject the request with
// "does not support thinking".
func ThinkParam(model string) (any, bool) {
	name := strings.ToLower(strings.TrimSpace(model))
	if name == "" {
		return nil, false
	}

	// Gemma-4-E4B and other E4B completion-only tags must omit think.
	if strings.Contains(name, "e4b") {
		return nil, false
	}

	// gpt-oss ignores boolean think values and requires a level instead.
	if strings.Contains(name, "gpt-oss") {
		return "medium", true
	}

	// Known thinking families.
	if strings.Contains(name, "qwen3") || strings.Contains(name, "deepseek-r1") {
		return true, true
	}
	if isR1ThinkingVariant(name) {
		return true, true
	}
	if isGemma4Thinking(name) {
		return true, true
	}

	// Explicit thinking tags (after E4B exclusion).
	if strings.Contains(name, "thinking") {
		return true, true
	}

	return nil, false
}

func isR1ThinkingVariant(name string) bool {
	if strings.Contains(name, "deepseek-r1") {
		return true
	}
	for _, marker := range []string{"-r1", ":r1", "_r1", "/r1", "r1:", "r1-", "r1_", "r1/"} {
		if strings.Contains(name, marker) {
			return true
		}
	}
	return name == "r1"
}

func isGemma4Thinking(name string) bool {
	// Enable think for the Gemma 4 family (e2b, 26b, etc.).
	// E4B completion-only tags are excluded earlier in ThinkParam.
	return strings.Contains(name, "gemma-4") || strings.Contains(name, "gemma4")
}

func IsThinkUnsupported(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(strings.ToLower(err.Error()), "does not support thinking")
}

// TagParser incrementally splits DeepSeek/Qwen-style <think> tags out of
// streamed content. Newer models (gpt-oss, Qwen3.8, Gemma 4) emit a separate
// `thinking` field and do not need this, but older Ollama/DeepSeek-R1
// responses still embed the tags in content.
type TagParser struct {
	inThink  bool
	leftover string
}

type ParseResult struct {
	Thinking   string
	Content    string
	EnterThink bool
	ExitThink  bool
}

func (p *TagParser) Feed(chunk string) ParseResult {
	s := p.leftover + chunk
	p.leftover = ""
	return p.consume(s, true)
}

func (p *TagParser) Flush() ParseResult {
	s := p.leftover
	p.leftover = ""
	return p.consume(s, false)
}

func (p *TagParser) consume(s string, holdPartial bool) ParseResult {
	var result ParseResult
	if s == "" {
		return result
	}

	for s != "" {
		if p.inThink {
			idx := strings.Index(s, thinkCloseTag)
			if idx == -1 {
				if holdPartial {
					if n := longestPartialSuffix(s, thinkCloseTag); n > 0 {
						result.Thinking += s[:len(s)-n]
						p.leftover = s[len(s)-n:]
						return result
					}
				}
				result.Thinking += s
				return result
			}
			result.Thinking += s[:idx]
			s = s[idx+len(thinkCloseTag):]
			p.inThink = false
			result.ExitThink = true
			continue
		}

		idx := strings.Index(s, thinkOpenTag)
		if idx == -1 {
			if holdPartial {
				if n := longestPartialSuffix(s, thinkOpenTag); n > 0 {
					result.Content += s[:len(s)-n]
					p.leftover = s[len(s)-n:]
					return result
				}
			}
			result.Content += s
			return result
		}
		result.Content += s[:idx]
		s = s[idx+len(thinkOpenTag):]
		p.inThink = true
		result.EnterThink = true
	}

	return result
}

func longestPartialSuffix(s, token string) int {
	max := len(token) - 1
	if max > len(s) {
		max = len(s)
	}
	for n := max; n > 0; n-- {
		if strings.HasSuffix(s, token[:n]) {
			return n
		}
	}
	return 0
}
