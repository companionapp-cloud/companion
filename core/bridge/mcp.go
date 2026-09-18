package bridge

import (
	"companion/core/domain"
	"companion/core/mcp"

	"companion/core/agents"
)

// mcpEndpointFor returns the Companion-tools MCP endpoint for a CLI agent, starting the
// loopback server on first use and issuing (or reusing) the agent's bearer token. The token's
// grant mirrors the agent's allow_write flag (Companion write tools), so an agent with write
// tools off only sees read tools. System access (files/commands) is the CLI's own concern. Returns
// nil if the server cannot start; the CLI then runs without Companion tools.
func (c *Core) mcpEndpointFor(agent *domain.Agent) *agents.MCPEndpoint {
	c.chatMu.Lock()
	defer c.chatMu.Unlock()
	if c.mcp == nil {
		srv := mcp.New(c.toolRegistry(), nil)
		// A write through MCP is a write like any other: refresh open views.
		srv.SetWriteHook(func(string) { c.emitDataChanged("", "") })
		if _, err := srv.Start(); err != nil {
			return nil
		}
		c.mcp = srv
		c.mcpTokens = map[string]string{}
	}
	url, err := c.mcp.URL()
	if err != nil {
		return nil
	}
	tok, ok := c.mcpTokens[agent.ID]
	if !ok {
		tok = c.mcp.IssueToken(mcp.Grant{AgentID: agent.ID, AllowWrite: agent.AllowWrite})
		c.mcpTokens[agent.ID] = tok
	} else {
		c.mcp.UpdateGrant(agent.ID, agent.AllowWrite)
	}
	return &agents.MCPEndpoint{URL: url, Token: tok}
}
