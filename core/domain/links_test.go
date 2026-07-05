package domain

import "testing"

func TestParseRefs(t *testing.T) {
	cases := []struct {
		name string
		md   string
		want []Ref
	}{
		{"none", "just some plain text", nil},
		{
			"plain ref",
			"see [[note:abc]] for context",
			[]Ref{{TargetType: "note", TargetID: "abc", Kind: KindRef}},
		},
		{
			"embed",
			"![[task:t1]]",
			[]Ref{{TargetType: "task", TargetID: "t1", Kind: KindEmbed}},
		},
		{
			"alias is stripped from id",
			"[[note:abc|My Note]]",
			[]Ref{{TargetType: "note", TargetID: "abc", Kind: KindRef}},
		},
		{
			"whitespace tolerated",
			"[[ note : abc ]]",
			[]Ref{{TargetType: "note", TargetID: "abc", Kind: KindRef}},
		},
		{
			"multiple, order preserved",
			"[[note:a]] then [[task:b]] then ![[habit:c]]",
			[]Ref{
				{TargetType: "note", TargetID: "a", Kind: KindRef},
				{TargetType: "task", TargetID: "b", Kind: KindRef},
				{TargetType: "habit", TargetID: "c", Kind: KindEmbed},
			},
		},
		{
			"dedup identical triples",
			"[[note:a]] [[note:a]]",
			[]Ref{{TargetType: "note", TargetID: "a", Kind: KindRef}},
		},
		{
			"ref and embed to same target are distinct",
			"[[note:a]] ![[note:a]]",
			[]Ref{
				{TargetType: "note", TargetID: "a", Kind: KindRef},
				{TargetType: "note", TargetID: "a", Kind: KindEmbed},
			},
		},
		{
			"unknown type ignored",
			"[[page:x]] [[note:y]]",
			[]Ref{{TargetType: "note", TargetID: "y", Kind: KindRef}},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ParseRefs(tc.md)
			if len(got) != len(tc.want) {
				t.Fatalf("ParseRefs(%q) = %+v, want %+v", tc.md, got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Errorf("ref[%d] = %+v, want %+v", i, got[i], tc.want[i])
				}
			}
		})
	}
}
