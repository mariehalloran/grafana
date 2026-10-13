package dataquery

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestAzureMonitorQueryPreservesHealthModelsOptions(t *testing.T) {
	input := []byte(`{"refId":"A","queryType":"Azure Monitor Health Models","azureHealthModels":{"healthModelResourceId":"/subscriptions/sub/resourceGroups/rg/providers/Microsoft.CloudHealth/healthmodels/model","resultFormat":"timeSeries"}}`)

	var query AzureMonitorQuery
	if err := json.Unmarshal(input, &query); err != nil {
		t.Fatalf("unmarshal query: %v", err)
	}

	encoded, err := json.Marshal(query)
	if err != nil {
		t.Fatalf("marshal query: %v", err)
	}

	var want map[string]any
	if err := json.Unmarshal(input, &want); err != nil {
		t.Fatalf("unmarshal expected query: %v", err)
	}

	var got map[string]any
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatalf("unmarshal round-tripped query: %v", err)
	}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("round-tripped query mismatch:\ngot:  %s\nwant: %s", encoded, input)
	}
}
