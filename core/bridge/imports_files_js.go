//go:build js

package bridge

import "errors"

// A browser has no folder to read: importing files is for the desktop and mobile apps.
var errNoFileImport = errors.New("importing a folder of files isn’t available in the browser — use the desktop app")

func (c *Core) importFilesScan([]byte) ([]byte, error) { return nil, errNoFileImport }
func (c *Core) importFilesRun([]byte) ([]byte, error)  { return nil, errNoFileImport }
