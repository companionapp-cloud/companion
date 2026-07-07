package bridge

import (
	"encoding/json"

	"companion/core/store"
)

// objectTypesChangedEvent lets object-type settings refresh; data.changed refreshes the
// graph (clustering by archetype) and any open editors showing an object form (PLAN §6.3).
const objectTypesChangedEvent = "objectTypes.changed"

func (c *Core) emitObjectTypeChanged(id string) {
	c.emit(objectTypesChangedEvent, nil)
	c.emitDataChanged("object_type", id)
}

func (c *Core) objectTypesList() ([]byte, error) {
	types, err := c.store.ObjectTypes.List()
	if err != nil {
		return nil, err
	}
	return json.Marshal(types)
}

func (c *Core) objectTypesGet(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	o, err := c.store.ObjectTypes.Get(args.ID)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	return json.Marshal(o)
}

func (c *Core) objectTypesCreate(payload []byte) ([]byte, error) {
	var in store.CreateObjectTypeInput
	if err := unmarshal(payload, &in); err != nil {
		return nil, err
	}
	o, err := c.store.ObjectTypes.Create(in)
	if err != nil {
		return nil, err
	}
	c.emitObjectTypeChanged(o.ID)
	return json.Marshal(o)
}

func (c *Core) objectTypesUpdate(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
		store.UpdateObjectTypeInput
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	o, err := c.store.ObjectTypes.Update(args.ID, args.UpdateObjectTypeInput)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	c.emitObjectTypeChanged(o.ID)
	return json.Marshal(o)
}

// objectTypesDelete tombstones a type. Entities keep their (now dangling) object_type_id,
// tolerated like a dangling wikilink (PLAN §5.1). Emits data.changed so the graph drops
// the type's cluster.
func (c *Core) objectTypesDelete(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if err := c.store.ObjectTypes.Delete(args.ID); err != nil {
		return nil, mapStoreErr(err)
	}
	c.emitObjectTypeChanged(args.ID)
	return json.Marshal(map[string]bool{"ok": true})
}
