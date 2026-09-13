-- Canvas edges gain a line style (curved | step | straight) alongside their endings
-- (PLAN-canvases.md); existing arrows keep the curved default.
ALTER TABLE canvas_edges ADD COLUMN style TEXT NOT NULL DEFAULT 'curved';
