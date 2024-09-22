import { tryInstantiate } from "./tryInstantiate"
import { argsForACLEDCatalog } from "../../../../DCAT3Interpretation/__mocks__/argsForACLEDCatalog"
import { setupContainer } from "../../../../__tests__/utils/setupContainer";
import { setup } from "../../../../setup";
import { MockSet } from "../../../../setup/constants";
import { SEC } from "../../../../constants";

test('tryInstantiate', async () => {
  const { catalogService, environment } = await setupContainer();
  const hostName = "http://localhost:3030/";
  await setup({ catalogService, hostName, mockSet: MockSet.ACLED });
  catalogService.runUpdate(["DELETE WHERE {?s ?p ?o }"]); //clear the dataset
  const actual = await tryInstantiate({
      service: catalogService, 
      type: argsForACLEDCatalog.type,
      id: argsForACLEDCatalog.id,
      triples: argsForACLEDCatalog.triples,
     })
  
  await environment.down()
}, 60 * SEC)